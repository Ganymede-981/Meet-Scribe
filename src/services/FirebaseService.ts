import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  Firestore,
} from 'firebase/firestore';
import {
  getAuth,
  Auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  User,
} from 'firebase/auth';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export interface MeetingRecord {
  id?: string;
  meetUrl: string;
  summary: string;
  transcript: string[];
  createdAt: Date;
  duration?: number;
}

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;

// ── Init ──────────────────────────────────────────────────────
export function initFirebase(config: FirebaseConfig): boolean {
  try {
    if (!config.projectId || !config.apiKey || !config.appId) return false;
    if (getApps().length === 0) {
      app = initializeApp(config);
    } else {
      app = getApps()[0];
    }
    db = getFirestore(app);
    auth = getAuth(app);
    return true;
  } catch {
    return false;
  }
}

// ── Auto-init from VITE_ environment variables ────────────────
// These are baked into the JS bundle at build time by Vite.
// Set them in your .env file (local dev) or in the Netlify /
// Docker build settings for production.
(function autoInit() {
  const cfg: FirebaseConfig = {
    apiKey:            import.meta.env.VITE_FB_API_KEY             ?? '',
    authDomain:        import.meta.env.VITE_FB_AUTH_DOMAIN         ?? '',
    projectId:         import.meta.env.VITE_FB_PROJECT_ID          ?? '',
    storageBucket:     import.meta.env.VITE_FB_STORAGE_BUCKET      ?? '',
    messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID ?? '',
    appId:             import.meta.env.VITE_FB_APP_ID              ?? '',
  };
  if (cfg.projectId && cfg.apiKey && cfg.appId) {
    initFirebase(cfg);
  }
})();

export function isFirebaseReady(): boolean {
  return auth !== null && db !== null;
}

export function getFirebaseAuth(): Auth | null {
  return auth;
}

// ── Auth ─────────────────────────────────────────────────────
export async function signInWithEmail(email: string, password: string): Promise<User> {
  if (!auth) throw new Error('Firebase not initialized. Set VITE_FB_* environment variables.');
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signUpWithEmail(email: string, password: string): Promise<User> {
  if (!auth) throw new Error('Firebase not initialized. Set VITE_FB_* environment variables.');
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signInWithGoogle(): Promise<User> {
  if (!auth) throw new Error('Firebase not initialized. Set VITE_FB_* environment variables.');
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function signOut(): Promise<void> {
  if (auth) await firebaseSignOut(auth);
}

export function onAuthStateChanged(callback: (user: User | null) => void): () => void {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return firebaseOnAuthStateChanged(auth, callback);
}

export async function getIdToken(): Promise<string | null> {
  const user = auth?.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export function getCurrentUser(): User | null {
  return auth?.currentUser ?? null;
}
