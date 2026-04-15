import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';

let initialized = false;

export function initFirebaseAdmin(): void {
  if (initialized) return;

  try {
    let credential: admin.credential.Credential;

    // Option 1: JSON string in env (great for cloud deployments)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(serviceAccount);
    }
    // Option 2: Path to JSON file (local dev)
    else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
      if (!existsSync(path)) {
        console.warn(`[Firebase] Service account file not found at: ${path}`);
        console.warn('[Firebase] Running without admin SDK — auth verification disabled');
        return;
      }
      const serviceAccount = JSON.parse(readFileSync(path, 'utf-8'));
      credential = admin.credential.cert(serviceAccount);
    } else {
      console.warn('[Firebase] No service account configured. Auth verification disabled.');
      return;
    }

    admin.initializeApp({ credential });
    initialized = true;
    console.log('[Firebase Admin] Initialized successfully');
  } catch (err) {
    console.error('[Firebase Admin] Init failed:', err);
  }
}

export function getAdminDb(): admin.firestore.Firestore {
  return admin.firestore();
}

export async function verifyIdToken(token: string): Promise<admin.auth.DecodedIdToken | null> {
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

export async function saveMeetingRecord(record: {
  sessionId: string;
  userId: string;
  meetUrl: string;
  transcript: string[];
  summary: string;
  duration: number;
  createdAt: Date;
}): Promise<string | null> {
  if (!initialized) return null;
  try {
    const db = getAdminDb();
    const ref = await db.collection('meetings').add({
      ...record,
      createdAt: admin.firestore.Timestamp.fromDate(record.createdAt),
    });
    return ref.id;
  } catch (err) {
    console.error('[Firestore] Save error:', err);
    return null;
  }
}

export async function getUserMeetings(userId: string) {
  if (!initialized) return [];
  try {
    const db = getAdminDb();
    const snap = await db
      .collection('meetings')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('[Firestore] Query error:', err);
    return [];
  }
}
