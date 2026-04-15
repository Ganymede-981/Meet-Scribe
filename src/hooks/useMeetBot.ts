import { useState, useRef, useCallback, useEffect } from 'react';
import { getIdToken } from '../services/FirebaseService';

export type BotStatus =
  | 'idle'
  | 'initializing'
  | 'connecting'
  | 'active'
  | 'processing'
  | 'completed'
  | 'error';

export type RecordingMode = 'audio' | 'bot';

interface UseMeetBotProps {
  backendUrl: string; // e.g. "http://localhost:3001"
  userId: string | null;
}

export interface UseMeetBotReturn {
  status: BotStatus;
  meetUrl: string;
  summary: string | null;
  transcript: string[];
  progress: number;
  savedToCloud: boolean;
  recordingMode: RecordingMode;
  isRecording: boolean;
  errorMessage: string;
  deployBot: (url: string, mode: RecordingMode) => Promise<void>;
  stopRecording: () => void;
  reset: () => void;
}

const BASE_LOCAL_KEY = 'scribeai_meetings';

export interface LocalMeetingRecord {
  meetUrl: string;
  summary: string;
  createdAt: string; // ISO String
  transcript: string[];
}

/** Returns the user-scoped localStorage key so different users don't share history. */
function localKey(userId?: string | null): string {
  return userId ? `${BASE_LOCAL_KEY}_${userId}` : BASE_LOCAL_KEY;
}

export function getLocalMeetings(userId?: string | null): LocalMeetingRecord[] {
  try {
    return JSON.parse(localStorage.getItem(localKey(userId)) || '[]');
  } catch {
    return [];
  }
}

function saveLocal(meetUrl: string, summary: string, transcript: string[], userId?: string | null): void {
  try {
    const existing = getLocalMeetings(userId);
    localStorage.setItem(
      localKey(userId),
      JSON.stringify([{ meetUrl, summary, transcript, createdAt: new Date().toISOString() }, ...existing])
    );
  } catch { /* storage full or blocked */ }
}

export function useMeetBot({ backendUrl, userId }: UseMeetBotProps): UseMeetBotReturn {
  const [status, setStatus] = useState<BotStatus>('idle');
  const [meetUrl, setMeetUrl] = useState('');
  const [summary, setSummary] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [savedToCloud, setSavedToCloud] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('audio');
  const [isRecording, setIsRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ── Cleanup on unmount ──────────────────────────────────────
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── Create a backend session and return sessionId ────────────
  const createSession = useCallback(async (url: string, mode: RecordingMode): Promise<string | null> => {
    const token = await getIdToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${backendUrl}/api/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        meetUrl: url,
        useBot: mode === 'bot', // only launch Puppeteer if bot mode
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Backend request failed' }));
      throw new Error(err.error ?? `Server error ${res.status}`);
    }

    const { sessionId } = await res.json();
    return sessionId;
  }, [backendUrl]);

  // ── Open WebSocket to backend ────────────────────────────────
  const openWebSocket = useCallback((sessionId: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const wsUrl = backendUrl.replace(/^http/, 'ws') + `/ws?sessionId=${sessionId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timed out'));
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Could not connect to backend. Is the server running?'));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            status?: string;
            progress?: number;
            text?: string;
            message?: string;
            storage?: string;
          };

          switch (msg.type) {
            case 'status':
              setStatus(msg.status as BotStatus);
              if (msg.progress !== undefined) setProgress(msg.progress);
              if (msg.status === 'error') setErrorMessage(msg.message ?? 'Unknown error');
              break;
            case 'transcript':
              if (msg.text) setTranscript((prev) => [...prev, msg.text!]);
              break;
            case 'summary':
              if (msg.text) setSummary(msg.text);
              break;
            case 'saved':
              setSavedToCloud(msg.storage === 'firestore');
              break;
          }
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = () => {
        wsRef.current = null;
      };
    });
  }, [backendUrl]);

  // ── Audio recording mode: capture mic/screen + POST audio ────
  const startAudioRecording = useCallback(async (sessionId: string): Promise<void> => {
    let stream: MediaStream;

    try {
      // Try to capture system/tab audio (user shares a tab)
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 16000,
        },
        video: false,
      });
    } catch {
      // Fallback to microphone if screen share is denied/cancelled
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    streamRef.current = stream;
    audioChunksRef.current = [];
    setIsRecording(true);
    setStatus('active');
    setProgress(50);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      setIsRecording(false);
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      if (audioChunksRef.current.length === 0) {
        setStatus('error');
        setErrorMessage('No audio was captured.');
        return;
      }

      // Send audio to backend for Gemini processing
      setStatus('processing');
      setProgress(75);

      try {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');
        formData.append('sessionId', sessionId);

        const token = await getIdToken();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        await fetch(`${backendUrl}/api/process-audio`, {
          method: 'POST',
          headers,
          body: formData,
        });
        // Results come back via WebSocket — nothing more to do here
      } catch (err) {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Failed to upload audio');
      }
    };

    // Stream is stopped when user ends screen share
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (recorder.state === 'recording') recorder.stop();
    });

    recorder.start(5000); // collect a chunk every 5 seconds
  }, [backendUrl]);

  // ── Main: deploy bot ────────────────────────────────────────
  const deployBot = useCallback(async (url: string, mode: RecordingMode): Promise<void> => {
    setStatus('initializing');
    setProgress(10);
    setMeetUrl(url);
    setSummary(null);
    setTranscript([]);
    setSavedToCloud(false);
    setErrorMessage('');
    setRecordingMode(mode);

    try {
      // 1. Create session on backend
      const sessionId = await createSession(url, mode);
      if (!sessionId) throw new Error('Failed to create session');
      sessionIdRef.current = sessionId;

      // 2. Connect WebSocket for real-time updates
      await openWebSocket(sessionId);
      setStatus('connecting');
      setProgress(25);

      // 3. Start audio capture (audio mode) or let backend drive (bot mode)
      if (mode === 'audio') {
        await startAudioRecording(sessionId);
      }
      // In bot mode, the Puppeteer bot drives status updates via WebSocket
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
      setStatus('error');
      setErrorMessage(msg);
    }
  }, [createSession, openWebSocket, startAudioRecording]);

  // ── Stop recording (for audio mode) ─────────────────────────
  const stopRecording = useCallback((): void => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }

    // For bot mode, send stop signal to backend
    if (recordingMode === 'bot' && sessionIdRef.current) {
      getIdToken().then((token) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        fetch(`${backendUrl}/api/stop`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        }).catch(console.error);
      });
    }
  }, [backendUrl, recordingMode]);

  // ── Save locally if backend/Firestore not available ──────────
  useEffect(() => {
    if (status === 'completed' && summary && meetUrl && !savedToCloud) {
      saveLocal(meetUrl, summary, transcript, userId);
    }
  }, [status, summary, meetUrl, savedToCloud, transcript, userId]);

  const reset = useCallback((): void => {
    wsRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    sessionIdRef.current = null;
    setStatus('idle');
    setMeetUrl('');
    setSummary(null);
    setTranscript([]);
    setProgress(0);
    setSavedToCloud(false);
    setIsRecording(false);
    setErrorMessage('');
  }, []);

  return {
    status,
    meetUrl,
    summary,
    transcript,
    progress,
    savedToCloud,
    recordingMode,
    isRecording,
    errorMessage,
    deployBot,
    stopRecording,
    reset,
  };
}
