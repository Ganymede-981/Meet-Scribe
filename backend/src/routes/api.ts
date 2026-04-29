import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { unlink } from 'fs/promises';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { createSession, sessions, broadcastToSession, activeBots } from '../index.js';
import { MeetBot } from '../bot/MeetBot.js';
import { processAudio, summarizeTranscript, isValidMeetUrl } from '../services/GroqService.js';
import { saveMeetingRecord, getUserMeetings } from '../services/FirebaseAdmin.js';

export const apiRouter = Router();

// Multer config: preserve extensions for Groq/Whisper type detection
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, 'tmp/');
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = file.originalname.includes('.')
      ? path.extname(file.originalname)
      : '.webm';
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'video/webm'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Track bot instances per session so we can stop them
const botInstances = new Map<string, MeetBot>();

// Track which sessions are active per user — prevents zombie bots on reconnect
const userActiveSessions = new Map<string, string>(); // userId → sessionId

// ── POST /api/start ────────────────────────────────────────────
apiRouter.post('/start', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { meetUrl, useBot = false } = req.body as { meetUrl: string; useBot?: boolean };

  if (!meetUrl || !isValidMeetUrl(meetUrl)) {
    return res.status(400).json({ error: 'Invalid Google Meet URL format' });
  }

  const userId = req.userId!;

  // ── Guard: kill any existing bot for this user before starting a new one ──
  // This prevents zombie Chromium instances when the frontend reconnects or the
  // user clicks "Deploy Bot" a second time.
  if (useBot) {
    const existingSessionId = userActiveSessions.get(userId);
    if (existingSessionId) {
      const existingBot = botInstances.get(existingSessionId);
      if (existingBot) {
        console.log(`[API] Stopping existing bot for user ${userId} (session ${existingSessionId}) before starting a new one`);
        existingBot.stop().catch(() => {});
      }
      userActiveSessions.delete(userId);
    }
  }

  const session = createSession(userId, meetUrl);
  console.log(`[API] Session created: ${session.id} for user ${userId}`);

  // 1. Send the Session ID to the frontend IMMEDIATELY so the WebSocket connects
  res.json({ sessionId: session.id });

  // 2. Launch the Playwright bot in the background (Non-blocking)
  if (useBot) {
    userActiveSessions.set(userId, session.id);
    const bot = new MeetBot();
    botInstances.set(session.id, bot);
    activeBots.add(bot);

    bot.joinMeeting(session.id, meetUrl).then(async (success) => {
      // THIS RUNS WHEN THE BOT LEAVES THE MEETING
      userActiveSessions.delete(userId);
      const currentSession = sessions.get(session.id);

      // Summarize if there is ANY transcript — regardless of whether the bot exited
      // cleanly (success=true) or was stopped early (success=false). This ensures
      // clicking "Stop Bot" always produces a summary if captions were captured.
      if (currentSession && currentSession.transcript.length > 0 && !currentSession.summary) {
        try {
          // Lock the summary state to prevent race conditions if the user clicks Stop simultaneously
          currentSession.summary = 'processing';
          broadcastToSession(session.id, { type: 'status', status: 'processing', progress: 80 });

          const fullText = currentSession.transcript.join('\n');
          const summary = await summarizeTranscript(fullText);
          currentSession.summary = summary;

          broadcastToSession(session.id, { type: 'summary', text: summary });
          broadcastToSession(session.id, { type: 'status', status: 'completed', progress: 100 });

          await saveMeetingRecord({
            sessionId: session.id,
            userId,
            meetUrl: currentSession.meetUrl,
            transcript: currentSession.transcript,
            summary,
            duration: Math.round((Date.now() - currentSession.createdAt.getTime()) / 1000),
            createdAt: currentSession.createdAt,
          });

          broadcastToSession(session.id, { type: 'saved', storage: 'firestore' });
        } catch (err: any) {
          console.error(`[Groq] Auto-Summary failed for session ${session.id}:`, err.message);
          currentSession.summary = null; // unlock on error so it can be retried if needed
          broadcastToSession(session.id, { type: 'status', status: 'error', message: `Summary failed: ${err.message}` });
        }
      } else if (currentSession && currentSession.transcript.length === 0) {
        broadcastToSession(session.id, { type: 'status', status: 'error', message: 'Bot left the meeting but no captions were captured.' });
      }

      // Cleanup bot instance
      activeBots.delete(bot);
      botInstances.delete(session.id);

    }).catch((err) => {
      console.error(`[Bot] Unhandled error in session ${session.id}:`, err);
      userActiveSessions.delete(userId);
      activeBots.delete(bot);
      botInstances.delete(session.id);
    });
  }
});

// ── POST /api/process-audio ────────────────────────────────────
// Receives a recorded audio blob, processes it through Groq/Gemini,
// then streams results via WebSocket and saves to Firestore.
apiRouter.post(
  '/process-audio',
  requireAuth,
  upload.single('audio'),
  async (req: AuthenticatedRequest, res) => {
    const { sessionId } = req.body as { sessionId: string };
    const file = req.file;

    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!file) return res.status(400).json({ error: 'audio file is required' });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Acknowledge the upload immediately so the frontend doesn't timeout
    res.json({ status: 'processing', sessionId });

    const send = (payload: object) => broadcastToSession(sessionId, payload);

    try {
      send({ type: 'status', status: 'processing', progress: 75 });
      console.log(`[Groq] Processing audio for session ${sessionId} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

      const { transcript, summary } = await processAudio(file.path, file.mimetype || 'audio/webm');

      // Update session
      session.transcript = transcript;
      session.summary = summary;

      // Stream transcript lines to frontend
      for (const line of transcript) {
        send({ type: 'transcript', text: line });
        await new Promise((r) => setTimeout(r, 50)); // small delay for visual effect
      }

      send({ type: 'summary', text: summary });
      send({ type: 'status', status: 'completed', progress: 100 });

      // Save to Firestore
      const docId = await saveMeetingRecord({
        sessionId,
        userId: req.userId!,
        meetUrl: session.meetUrl,
        transcript,
        summary,
        duration: Math.round((Date.now() - session.createdAt.getTime()) / 1000),
        createdAt: session.createdAt,
      });

      if (docId) {
        send({ type: 'saved', docId, storage: 'firestore' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Processing failed';
      console.error(`[Groq] Error for session ${sessionId}:`, message);
      send({ type: 'status', status: 'error', message });
    } finally {
      // Always clean up the temp audio file
      unlink(file.path).catch(() => { });
    }
  }
);

// ── POST /api/stop ─────────────────────────────────────────────
// Stops the bot and processes any buffered captions as the transcript.
apiRouter.post('/stop', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: 'Session not found' });

  // 1. If the Playwright bot is running, tell it to stop.
  const bot = botInstances.get(sessionId);
  if (bot) {
    await bot.stop();
    // Do NOT summarize here. bot.stop() will cause the Promise in the /start route to resolve,
    // which handles the background summarization and database saving automatically.
    return res.json({ status: 'stopping_bot' });
  }

  const send = (payload: object) => broadcastToSession(sessionId, payload);

  // 2. If no bot is running (e.g., standard audio dictation mode), summarize manually here.
  if (session.transcript.length > 0 && !session.summary) {
    try {
      session.summary = "processing"; // lock
      send({ type: 'status', status: 'processing', progress: 80 });

      const fullText = session.transcript.join('\n');
      const summary = await summarizeTranscript(fullText);
      session.summary = summary;

      send({ type: 'summary', text: summary });
      send({ type: 'status', status: 'completed', progress: 100 });

      await saveMeetingRecord({
        sessionId,
        userId: req.userId!,
        meetUrl: session.meetUrl,
        transcript: session.transcript,
        summary,
        duration: Math.round((Date.now() - session.createdAt.getTime()) / 1000),
        createdAt: session.createdAt,
      });

      send({ type: 'saved', storage: 'firestore' });
    } catch (err: any) {
      console.error(`[Groq] Summary failed for session ${sessionId}:`, err.message);
      session.summary = null;
      send({ type: 'status', status: 'error', message: `Summary failed: ${err.message}` });
    }
  } else {
    send({ type: 'status', status: 'completed', progress: 100 });
  }

  return res.json({ status: 'stopped' });
});

// ── GET /api/meetings ──────────────────────────────────────────
// Returns the authenticated user's past meetings from Firestore.
apiRouter.get('/meetings', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const meetings = await getUserMeetings(req.userId!);
    return res.json({ meetings });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch meetings' });
  }
});