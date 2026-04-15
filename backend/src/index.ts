import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync } from 'fs';
import { apiRouter } from './routes/api.js';
import { initFirebaseAdmin } from './services/FirebaseAdmin.js';

// Ensure tmp/ directory exists for multer audio uploads
mkdirSync('tmp', { recursive: true });

// ─── Init Firebase Admin ─────────────────────────────────────
initFirebaseAdmin();


// ─── Express app ────────────────────────────────────────────
const app = express();

// CORS: supports comma-separated list and *.netlify.app preview deploys
const rawOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin / non-browser requests (curl, mobile apps, etc.)
    if (!origin) return callback(null, true);
    const allowed =
      rawOrigins.includes(origin) ||
      /^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(origin) ||
      /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin);
    callback(allowed ? null : new Error(`CORS: ${origin} not allowed`), allowed);
  },
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// API routes
app.use('/api', apiRouter);

// ─── HTTP server + WebSocket server ─────────────────────────
const server = createServer(app);
export const wss = new WebSocketServer({ server });

// ─── Session store (in-memory) ──────────────────────────────
// In production, use Redis for multi-instance support
export interface BotSession {
  id: string;
  userId: string;
  meetUrl: string;
  status: string;
  transcript: string[];
  summary: string | null;
  ws: WebSocket | null;
  createdAt: Date;
}

export const sessions = new Map<string, BotSession>();

export function createSession(userId: string, meetUrl: string): BotSession {
  const session: BotSession = {
    id: uuidv4(),
    userId,
    meetUrl,
    status: 'pending',
    transcript: [],
    summary: null,
    ws: null,
    createdAt: new Date(),
  };
  sessions.set(session.id, session);
  return session;
}

export function broadcastToSession(sessionId: string, payload: object): void {
  const session = sessions.get(sessionId);
  if (session?.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(payload));
  }
}

// ─── WebSocket connection handler ───────────────────────────
wss.on('connection', (ws, req) => {
  // URL format: /ws?sessionId=<id>
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(1008, 'Invalid or expired session ID');
    return;
  }

  const session = sessions.get(sessionId)!;
  session.ws = ws;

  console.log(`[WS] Client connected for session ${sessionId}`);
  ws.send(JSON.stringify({ type: 'connected', sessionId }));

  ws.on('close', () => {
    console.log(`[WS] Client disconnected from session ${sessionId}`);
    // Don't delete session — bot may still be running
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error on session ${sessionId}:`, err.message);
  });
});

// ─── Start server ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10);
server.listen(PORT, () => {
  console.log(`\n🚀 ScribeAI backend running at http://localhost:${PORT}`);
  console.log(`   WebSocket server at ws://localhost:${PORT}\n`);
});
