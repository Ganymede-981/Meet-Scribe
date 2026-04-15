import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  History,
  Bot,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Clock,
  Mic2,
  FileText,
  Search,
  Filter,
  Cloud,
  CloudOff,
  Database,
  Radio,
  Square,
  Server,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMeetBot, BotStatus, RecordingMode, getLocalMeetings, type LocalMeetingRecord } from './hooks/useMeetBot';
import { cn } from './utils/cn';
import Auth from './components/Auth';
import {
  isFirebaseReady,
  onAuthStateChanged,
  signOut,
  getIdToken,
  MeetingRecord,
} from './services/FirebaseService';
import type { User } from 'firebase/auth';

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:3001';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history'>('dashboard');
  const [meetUrlInput, setMeetUrlInput] = useState('');
  const [deployMode, setDeployMode] = useState<RecordingMode>('audio');
  const [firebaseReady] = useState(isFirebaseReady());
  const [cloudMeetings, setCloudMeetings] = useState<MeetingRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  const {
    status,
    meetUrl,
    summary,
    transcript,
    progress,
    savedToCloud,
    isRecording,
    errorMessage,
    deployBot,
    stopRecording,
    reset,
  } = useMeetBot({ backendUrl: BACKEND_URL, userId: user?.uid ?? null });

  // ── Auth state listener ──────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged((u) => {
      setUser(u ?? null);
      setAuthLoading(false);
    });
    return unsub;
  }, [firebaseReady]);

  // ── Clear stale cloud meetings whenever the user changes ─────
  useEffect(() => {
    setCloudMeetings([]);
  }, [user?.uid]);

  // ── Load cloud meetings when visiting History ────────────────
  useEffect(() => {
    if (activeTab !== 'history' || !user) return;

    // Fetch from backend API (uses Firebase Admin SDK — no Firestore rules needed)
    getIdToken().then(async (token) => {
      if (!token) return;
      try {
        const res = await fetch(`${BACKEND_URL}/api/meetings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        // Normalise timestamps: Firestore returns seconds/_seconds objects
        const meetings: MeetingRecord[] = (data.meetings ?? []).map((m: any) => ({
          id: m.id,
          meetUrl: m.meetUrl ?? m.url ?? '',
          summary: m.summary ?? '',
          transcript: m.transcript ?? [],
          createdAt: m.createdAt?._seconds
            ? new Date(m.createdAt._seconds * 1000)
            : new Date(m.createdAt),
          duration: m.duration,
        }));
        setCloudMeetings(meetings);
      } catch (err) {
        console.error('[History] Failed to fetch meetings:', err);
      }
    });
  }, [activeTab, user, status]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Auth onLogin={() => {
      if (!firebaseReady) {
        // Dev fallback: allow login without Firebase configured
        setUser({
          uid: 'demo-user',
          email: 'demo@scribeai.io',
          displayName: 'Demo User',
          photoURL: null,
          getIdToken: async () => 'demo-token',
        } as any);
      }
    }} />;
  }

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetUrlInput.trim()) return;
    await deployBot(meetUrlInput.trim(), deployMode);
  };

  const handleSignOut = async () => {
    setCloudMeetings([]);
    await signOut();
    reset();
  };

  const getStatusIcon = (s: BotStatus) => {
    switch (s) {
      case 'idle': return <Bot className="w-6 h-6 text-gray-400" />;
      case 'initializing': case 'connecting': return <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />;
      case 'active': return <Mic2 className="w-6 h-6 text-red-500 animate-pulse" />;
      case 'processing': return <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />;
      case 'completed': return <CheckCircle2 className="w-6 h-6 text-emerald-500" />;
      case 'error': return <AlertCircle className="w-6 h-6 text-rose-500" />;
    }
  };

  const allMeetings: Array<MeetingRecord | LocalMeetingRecord> = cloudMeetings.length > 0
    ? cloudMeetings
    : getLocalMeetings(user?.uid);

  const filteredMeetings = allMeetings.filter((m) =>
    (m.meetUrl ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (m.summary ?? '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatDate = (d: Date | string) => {
    try {
      return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch { return String(d); }
  };

  const userInitials = (user.displayName ?? user.email ?? 'U')
    .split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-white border-r border-slate-200 z-50 flex flex-col">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-8">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-violet-600">
              ScribeAI
            </span>
          </div>

          <nav className="space-y-2">
            {(['dashboard', 'history'] as const).map((tab) => (
              <button
                key={tab}
                id={`nav-${tab}`}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all capitalize',
                  activeTab === tab ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                )}
              >
                {tab === 'dashboard' && <LayoutDashboard size={20} />}
                {tab === 'history' && <History size={20} />}
                {tab === 'history' ? 'Meetings' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </nav>
        </div>

        <div className="mt-auto p-6 space-y-3">
          <div className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold',
            firebaseReady ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
          )}>
            {firebaseReady ? <Cloud className="w-4 h-4" /> : <CloudOff className="w-4 h-4" />}
            {firebaseReady ? 'Cloud Storage Active' : 'Local Storage Mode'}
          </div>

          <div className="bg-slate-900 rounded-2xl p-4 text-white">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center font-bold text-white text-sm">
                {user.photoURL ? <img src={user.photoURL} className="w-10 h-10 rounded-full" alt="" /> : userInitials}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{user.displayName ?? 'User'}</p>
                <p className="text-xs text-slate-400 truncate">{user.email}</p>
              </div>
            </div>
            <button
              id="sign-out-btn"
              onClick={handleSignOut}
              className="w-full text-xs text-rose-400 hover:text-rose-300 transition-colors text-left px-1"
            >
              Sign Out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-64 p-8 min-h-screen">
        <AnimatePresence mode="wait">

          {/* ── DASHBOARD ── */}
          {activeTab === 'dashboard' && (
            <motion.div key="dashboard" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-4xl mx-auto">
              <header className="mb-10">
                <h1 className="text-3xl font-bold mb-2">Welcome back{user.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}!</h1>
                <p className="text-slate-500">Ready to transcribe your next meeting?</p>
              </header>

              <div className="grid gap-6">
                {status === 'idle' && (
                  <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm">
                    <h2 className="text-xl font-semibold mb-2">New Meeting Scribe</h2>
                    <p className="text-slate-500 mb-6">Enter a Google Meet URL and choose how to capture the conversation.</p>

                    {/* Mode selector */}
                    <div className="grid grid-cols-2 gap-3 mb-6">
                      <button
                        id="mode-audio"
                        onClick={() => setDeployMode('audio')}
                        className={cn(
                          'flex items-start gap-3 p-4 rounded-2xl border-2 transition-all text-left',
                          deployMode === 'audio' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                        )}
                      >
                        <Radio className={cn('w-5 h-5 mt-0.5 shrink-0', deployMode === 'audio' ? 'text-indigo-600' : 'text-slate-400')} />
                        <div>
                          <p className="font-semibold text-sm">Record &amp; Transcribe</p>
                          <p className="text-xs text-slate-500 mt-0.5">Share your tab/screen audio — Groq processes the real audio file</p>
                        </div>
                      </button>
                      <button
                        id="mode-bot"
                        onClick={() => setDeployMode('bot')}
                        className={cn(
                          'flex items-start gap-3 p-4 rounded-2xl border-2 transition-all text-left',
                          deployMode === 'bot' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                        )}
                      >
                        <Server className={cn('w-5 h-5 mt-0.5 shrink-0', deployMode === 'bot' ? 'text-indigo-600' : 'text-slate-400')} />
                        <div>
                          <p className="font-semibold text-sm">Deploy Bot</p>
                          <p className="text-xs text-slate-500 mt-0.5">Bot joins the meeting via browser automation and scrapes live captions</p>
                        </div>
                      </button>
                    </div>

                    <form id="deploy-form" onSubmit={handleDeploy} className="flex gap-2">
                      <div className="relative flex-1">
                        <Bot className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                        <input
                          id="meet-url-input"
                          type="text"
                          placeholder="https://meet.google.com/abc-defg-hij"
                          className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                          value={meetUrlInput}
                          onChange={(e) => setMeetUrlInput(e.target.value)}
                        />
                      </div>
                      <button
                        id="deploy-btn"
                        type="submit"
                        className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-2xl transition-all flex items-center gap-2 group shadow-lg shadow-indigo-600/20 active:scale-[0.98]"
                      >
                        {deployMode === 'audio' ? 'Start Recording' : 'Deploy Bot'}
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                      </button>
                    </form>
                  </div>
                )}

                {/* Active session */}
                {status !== 'idle' && (
                  <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-lg">
                    <div className="p-8 border-b border-slate-100">
                      <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-4">
                          <div className={cn('w-12 h-12 rounded-2xl flex items-center justify-center', status === 'active' ? 'bg-red-50' : 'bg-indigo-50')}>
                            {getStatusIcon(status)}
                          </div>
                          <div>
                            <h3 className="text-lg font-bold flex items-center gap-2">
                              {status === 'active' && <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
                              {status === 'active' ? (isRecording ? '🔴 Recording' : '⏳ Waiting…') : `Scribe ${status}`}
                            </h3>
                            <p className="text-slate-500 text-sm truncate max-w-xs">{meetUrl}</p>
                          </div>
                        </div>
                        <div className="flex gap-2 items-center">
                          {status === 'active' && isRecording && (
                            <button
                              id="stop-recording-btn"
                              onClick={stopRecording}
                              className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 font-semibold rounded-xl text-sm transition-colors"
                            >
                              <Square className="w-4 h-4 fill-current" />
                              Stop &amp; Process
                            </button>
                          )}
                          {status === 'active' && !isRecording && deployMode === 'bot' && (
                            <button
                              id="stop-bot-btn"
                              onClick={stopRecording}
                              className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 font-semibold rounded-xl text-sm transition-colors"
                            >
                              <Square className="w-4 h-4 fill-current" />
                              Stop Bot
                            </button>
                          )}
                          {status === 'completed' && (
                            <>
                              <div className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border', savedToCloud ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-amber-50 text-amber-700 border-amber-100')}>
                                <div className="w-1.5 h-1.5 rounded-full animate-pulse bg-current" />
                                {savedToCloud ? 'SAVED TO FIRESTORE' : 'SAVED LOCALLY'}
                              </div>
                              <button id="new-meeting-btn" onClick={reset} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm font-medium transition-colors">
                                New Meeting
                              </button>
                            </>
                          )}
                          {status === 'error' && (
                            <button onClick={reset} className="px-4 py-2 bg-rose-50 text-rose-700 hover:bg-rose-100 rounded-xl text-sm font-medium transition-colors">
                              Try Again
                            </button>
                          )}
                        </div>
                      </div>

                      {status === 'error' && errorMessage && (
                        <div className="flex items-center gap-2 text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 mb-4">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          {errorMessage}
                        </div>
                      )}

                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-medium text-slate-500">
                          <span>Progress</span>
                          <span>{progress}%</span>
                        </div>
                        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                          <motion.div className="h-full bg-indigo-600" initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ duration: 0.5 }} />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 h-[400px]">
                      {/* Transcript panel */}
                      <div className="p-6 border-r border-slate-100 bg-slate-50/50 flex flex-col">
                        <div className="flex items-center gap-2 mb-4">
                          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Live Transcript</span>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-slate-200">
                          {transcript.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400 text-center p-6">
                              <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                                <Mic2 className="w-6 h-6 animate-pulse text-indigo-500" />
                              </div>
                              <p className="text-sm font-medium">
                                {status === 'active' && deployMode === 'audio' && isRecording
                                  ? 'Recording in progress… click "Stop & Process" when done'
                                  : 'Waiting for audio…'}
                              </p>
                            </div>
                          ) : (
                            transcript.map((line, i) => (
                              <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="bg-white p-3 rounded-2xl shadow-sm border border-slate-100 text-sm">
                                <div className="flex items-center gap-2 mb-1">
                                  <div className="w-4 h-4 rounded-full bg-indigo-100" />
                                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">Transcript line {i + 1}</span>
                                </div>
                                {line}
                              </motion.div>
                            ))
                          )}
                        </div>
                      </div>

                      {/* Summary panel */}
                      <div className="p-6 flex flex-col bg-white">
                        <div className="flex items-center gap-2 mb-4">
                          <FileText className="w-4 h-4 text-indigo-500" />
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">AI Summary</span>
                        </div>
                        <div className="flex-1 overflow-y-auto pr-2">
                          {status === 'completed' && summary ? (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="prose-custom text-sm">
                              <div className="whitespace-pre-wrap">{summary}</div>
                            </motion.div>
                          ) : status === 'processing' ? (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400">
                              <div className="w-12 h-12 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
                              <p className="text-sm">Groq is analysing your meeting audio…</p>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center h-full text-slate-300">
                              <FileText className="w-12 h-12 mb-2 opacity-20" />
                              <p className="text-sm">Summary appears after processing</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Stats when idle */}
                {status === 'idle' && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
                    <div className="bg-indigo-600 rounded-3xl p-6 text-white shadow-lg shadow-indigo-600/20">
                      <div className="bg-white/20 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
                        <Clock className="w-6 h-6" />
                      </div>
                      <p className="text-indigo-100 text-sm mb-1">Time Saved</p>
                      <p className="text-2xl font-bold">{allMeetings.length * 15} mins</p>
                    </div>
                    <div className="bg-white rounded-3xl p-6 border border-slate-200">
                      <div className="bg-slate-100 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
                        <History className="w-6 h-6 text-slate-600" />
                      </div>
                      <p className="text-slate-500 text-sm mb-1">Meetings Summarized</p>
                      <p className="text-2xl font-bold">{allMeetings.length}</p>
                    </div>
                    <div className="bg-white rounded-3xl p-6 border border-slate-200">
                      <div className="bg-slate-100 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
                        <CheckCircle2 className="w-6 h-6 text-slate-600" />
                      </div>
                      <p className="text-slate-500 text-sm mb-1">Powered by</p>
                      <p className="text-2xl font-bold">Llama 3 (Groq)</p>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* ── HISTORY ── */}
          {activeTab === 'history' && (
            <motion.div key="history" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-5xl mx-auto">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h1 className="text-3xl font-bold mb-2">Meeting History</h1>
                  <p className="text-slate-500">Your transcribed meetings{firebaseReady ? ' (synced from Firestore)' : ' (saved locally)'}.</p>
                </div>
                <div className="flex gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input id="history-search" type="text" placeholder="Search summaries…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/10 text-sm" />
                  </div>
                  <button className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium hover:bg-slate-50 transition-colors">
                    <Filter className="w-4 h-4" />
                    Filter
                  </button>
                </div>
              </div>

              <div className="grid gap-4">
                {filteredMeetings.length > 0 ? filteredMeetings.map((m, i) => (
                  <div key={('id' in m ? m.id : null) ?? i} className="bg-white p-5 rounded-2xl border border-slate-200 hover:border-indigo-300 transition-all group cursor-pointer">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                          <FileText className="w-6 h-6" />
                        </div>
                        <div>
                          <h3 className="font-bold group-hover:text-indigo-600 transition-colors truncate max-w-md">{m.meetUrl || 'Meeting'}</h3>
                          <div className="flex items-center gap-3 text-sm text-slate-500 mt-1">
                            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDate(m.createdAt)}</span>
                            <span className="text-xs text-slate-400 truncate max-w-xs">{m.summary?.slice(0, 70)}…</span>
                          </div>
                        </div>
                      </div>
                      <button className="p-2 hover:bg-slate-100 rounded-lg text-slate-400">
                        <ArrowRight className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                )) : (
                  <div className="text-center py-20 text-slate-400">
                    <Database className="w-12 h-12 mx-auto mb-4 opacity-30" />
                    <p className="font-medium">No meetings recorded yet</p>
                    <p className="text-sm mt-1">Deploy the scribe bot or start a recording to capture your first meeting.</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default App;
