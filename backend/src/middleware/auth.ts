import { Request, Response, NextFunction } from 'express';
import { verifyIdToken } from '../services/FirebaseAdmin.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

/**
 * Middleware to verify Firebase ID tokens.
 * If Firebase Admin is not configured, falls back to allowing all requests
 * (for local dev without a service account set up).
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }

  const token = authHeader.slice(7);

  // Skip verification in dev if Firebase is not configured
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_PATH && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.warn('[Auth] Firebase not configured — skipping token verification (dev mode)');
    req.userId = 'dev-user';
    req.userEmail = 'dev@local';
    next();
    return;
  }

  const decoded = await verifyIdToken(token);
  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.userId = decoded.uid;
  req.userEmail = decoded.email;
  next();
}
