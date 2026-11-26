import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/database.js';
import { recordSecurityEvent } from '../services/securityLogService.js';
import type { UserRole } from '../types.js';
import { sha256Hex } from './crypto.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'active' | 'suspended';
  sessionId: string;
  csrfToken: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}

export const SESSION_COOKIE_NAME = 'cadence_session';

export function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] ?? '' : val ?? '';
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${req.baseUrl}:${req.path}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (bucket.count >= maxRequests) {
      recordSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        ipAddress: ip,
        details: { endpoint: `${req.baseUrl}${req.path}` },
      });
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait before retrying.',
        retryAfterMs: bucket.resetAt - now,
      });
      return;
    }
    bucket.count += 1;
    next();
  };
}

export function clearRateLimitsForTest(): void {
  rateBuckets.clear();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');

  if (!rawToken) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const db = getDb();
  const tokenHash = sha256Hex(rawToken);
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.csrf_token, s.expires_at, u.email, u.name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as
    | {
        session_id: string;
        user_id: string;
        csrf_token: string;
        expires_at: string;
        email: string;
        name: string;
        role: UserRole;
        status: 'active' | 'suspended';
      }
    | undefined;

  if (!row) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  if (row.status === 'suspended') {
    res.status(403).json({ error: 'This user account has been suspended by an administrator.' });
    return;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return;
  }

  // CSRF check for mutating requests using cookie auth
  const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  const usesCookie = Boolean(cookies[SESSION_COOKIE_NAME]) && !req.headers.authorization;
  if (isMutating && usesCookie) {
    const headerCsrf = req.headers['x-csrf-token'];
    if (typeof headerCsrf !== 'string' || headerCsrf !== row.csrf_token) {
      res.status(403).json({ error: 'Invalid CSRF token' });
      return;
    }
  }

  db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), row.session_id);

  req.auth = {
    id: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role || 'member',
    status: row.status || 'active',
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
  };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.auth.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required' });
    return;
  }
  next();
}
