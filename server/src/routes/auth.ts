import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import {
  SESSION_COOKIE_NAME,
  param,
  parseCookies,
  rateLimit,
  requireAuth,
} from '../security/authMiddleware.js';
import { decryptSecret, generateToken, hashPassword, sha256Hex, verifyPassword } from '../security/crypto.js';
import {
  createLocalAccountForUser,
  ensureUserDefaults,
  seedStarterCorrespondence,
} from '../services/accountSetup.js';
import { recordSecurityEvent } from '../services/securityLogService.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  provisionLocalMailbox: z.boolean().optional().default(false),
  localEmailAddress: z.string().trim().email().optional(),
  seedStarter: z.boolean().optional().default(false),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

function createSession(userId: string, req: Parameters<typeof authRouter.post>[1] extends never ? never : any) {
  const db = getDb();
  const rawToken = generateToken(32);
  const csrfToken = generateToken(24);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 3600_000).toISOString();
  const nowIso = now.toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, user_agent, ip_address, expires_at, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    userId,
    sha256Hex(rawToken),
    csrfToken,
    String(req.headers['user-agent'] || '').slice(0, 300),
    String(req.ip || req.socket?.remoteAddress || ''),
    expiresAt,
    nowIso,
    nowIso
  );

  return { rawToken, csrfToken, sessionId, expiresAt };
}

function setSessionCookie(req: any, res: any, rawToken: string): void {
  const isHttps = Boolean(req.secure || req.headers?.['x-forwarded-proto'] === 'https');
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: 14 * 24 * 3600 * 1000,
    path: '/',
  });
}

authRouter.post('/register', rateLimit(20, 60_000), (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid registration details', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const { name, email, password, provisionLocalMailbox, localEmailAddress, seedStarter } = parsed.data;
  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const totalUsersRow = db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
  const isAdmin =
    totalUsersRow.cnt === 0 ||
    (Boolean(config.admin.bootstrapEmail) && email.toLowerCase() === config.admin.bootstrapEmail);
  const role = isAdmin ? 'admin' : 'member';

  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, quota_mb, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 1024, ?, ?)"
  ).run(userId, email.toLowerCase(), name, hashPassword(password), role, now, now);

  ensureUserDefaults(db, userId);

  let createdAccountId: string | null = null;
  if (provisionLocalMailbox) {
    const localAddr = (localEmailAddress || email).toLowerCase();
    createdAccountId = createLocalAccountForUser(db, userId, localAddr, name);
    if (seedStarter) {
      seedStarterCorrespondence(db, userId, createdAccountId, localAddr, name);
    }
  }

  const session = createSession(userId, req);
  setSessionCookie(req, res, session.rawToken);

  recordSecurityEvent(
    {
      userId,
      eventType: 'user_registered',
      severity: 'info',
      actorEmail: email.toLowerCase(),
      ipAddress: String(req.ip || req.socket?.remoteAddress || ''),
      details: { role },
    },
    db
  );

  res.status(201).json({
    user: { id: userId, email: email.toLowerCase(), name, role, status: 'active' },
    csrfToken: session.csrfToken,
    createdAccountId,
  });
});

authRouter.post('/login', rateLimit(30, 60_000), (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const db = getDb();
  const user = db
    .prepare('SELECT id, email, name, password_hash, role, status FROM users WHERE lower(email) = lower(?)')
    .get(parsed.data.email) as
    | { id: string; email: string; name: string; password_hash: string; role: string; status: string }
    | undefined;

  if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
    recordSecurityEvent(
      {
        userId: user?.id ?? null,
        eventType: 'login_failed',
        severity: 'warning',
        actorEmail: parsed.data.email.toLowerCase(),
        ipAddress: String(req.ip || req.socket?.remoteAddress || ''),
      },
      db
    );
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  if (user.status === 'suspended') {
    recordSecurityEvent(
      {
        userId: user.id,
        eventType: 'login_blocked_suspended',
        severity: 'warning',
        actorEmail: user.email,
        ipAddress: String(req.ip || req.socket?.remoteAddress || ''),
      },
      db
    );
    res.status(403).json({ error: 'Account suspended. Contact your platform administrator.' });
    return;
  }

  ensureUserDefaults(db, user.id);
  const session = createSession(user.id, req);
  setSessionCookie(req, res, session.rawToken);

  recordSecurityEvent(
    {
      userId: user.id,
      eventType: 'login_success',
      severity: 'info',
      actorEmail: user.email,
      ipAddress: String(req.ip || req.socket?.remoteAddress || ''),
    },
    db
  );

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status },
    csrfToken: session.csrfToken,
  });
});

authRouter.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (rawToken) {
    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(rawToken));
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/session', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) {
    res.json({ authenticated: false, user: null });
    return;
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.csrf_token, s.expires_at, u.email, u.name, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    )
    .get(sha256Hex(rawToken)) as
    | { session_id: string; user_id: string; csrf_token: string; expires_at: string; email: string; name: string; role: string; status: string }
    | undefined;
  if (!row || new Date(row.expires_at).getTime() <= Date.now() || row.status === 'suspended') {
    res.json({ authenticated: false, user: null });
    return;
  }
  const prefRow = db.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?').get(row.user_id) as
    | { preferences_json: string }
    | undefined;
  res.json({
    authenticated: true,
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role || 'member', status: row.status || 'active' },
    csrfToken: row.csrf_token,
    preferences: prefRow ? JSON.parse(prefRow.preferences_json) : null,
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();
  const prefRow = db.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?').get(auth.id) as
    | { preferences_json: string }
    | undefined;

  res.json({
    user: { id: auth.id, email: auth.email, name: auth.name, role: auth.role, status: auth.status },
    csrfToken: auth.csrfToken,
    preferences: prefRow ? JSON.parse(prefRow.preferences_json) : null,
  });
});

authRouter.get('/sessions', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, user_agent, ip_address, expires_at, created_at, last_active_at FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC'
    )
    .all(auth.id) as Array<{
    id: string;
    user_agent: string;
    ip_address: string;
    expires_at: string;
    created_at: string;
    last_active_at: string;
  }>;

  res.json({
    sessions: rows.map((r) => ({
      id: r.id,
      userAgent: r.user_agent,
      ipAddress: r.ip_address,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      isCurrent: r.id === auth.sessionId,
    })),
  });
});

authRouter.delete('/sessions/:id', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(param(req, 'id'), auth.id);
  res.json({ ok: true });
});

authRouter.delete('/sessions', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();
  const del = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(auth.id, auth.sessionId);
  recordSecurityEvent(
    {
      userId: auth.id,
      eventType: 'sessions_revoked_all_others',
      severity: 'info',
      actorEmail: auth.email,
      ipAddress: String(req.ip || req.socket?.remoteAddress || ''),
      details: { revokedCount: del.changes },
    },
    db
  );
  res.json({ ok: true, revokedCount: del.changes });
});

authRouter.get('/security-center', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();

  const events = db
    .prepare(
      'SELECT id, event_type, severity, ip_address, details_json, created_at FROM security_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 60'
    )
    .all(auth.id) as Array<{
    id: string;
    event_type: string;
    severity: string;
    ip_address: string;
    details_json: string;
    created_at: string;
  }>;

  const accounts = db
    .prepare('SELECT id, email_address, provider_type, status, used_bytes, quota_mb, encrypted_credentials FROM accounts WHERE user_id = ?')
    .all(auth.id) as Array<{
    id: string;
    email_address: string;
    provider_type: string;
    status: string;
    used_bytes: number;
    quota_mb: number;
    encrypted_credentials: string;
  }>;

  const attBytesRow = db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments WHERE user_id = ?')
    .get(auth.id) as { total: number };

  const oauthPermissions = accounts.map((a) => {
    let scopes: string[] = [];
    if (a.encrypted_credentials) {
      try {
        const creds = JSON.parse(decryptSecret(a.encrypted_credentials)) as { scope?: string };
        if (typeof creds.scope === 'string' && creds.scope.trim()) {
          scopes = creds.scope.trim().split(/\s+/);
        }
      } catch {
        // ignore decrypt issues on corrupted rows
      }
    }
    return {
      accountId: a.id,
      emailAddress: a.email_address,
      providerType: a.provider_type,
      status: a.status,
      scopes,
    };
  });

  const activeSessionCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ? AND expires_at > datetime('now')").get(auth.id) as { cnt: number }
  ).cnt;
  const expiredOrErrAccounts = accounts.filter((a) => a.status === 'auth_expired' || a.status === 'error').length;
  const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
  const totalBytes = accounts.reduce((sum, a) => sum + (a.used_bytes || 0), 0);

  const posture = [
    {
      id: 'encryption',
      label: 'Credential Storage Encryption',
      status: 'ok' as const,
      detail: 'Provider passwords and OAuth tokens are encrypted at rest with AES-256-GCM.',
    },
    {
      id: 'transport',
      label: 'Transport Security',
      status: isHttps ? ('ok' as const) : ('warning' as const),
      detail: isHttps
        ? 'HTTPS transport detected on current session.'
        : 'Running on local HTTP; use TLS/reverse proxy for remote deployment.',
    },
    {
      id: 'provider_health',
      label: 'Connected Account Auth Health',
      status: expiredOrErrAccounts === 0 ? ('ok' as const) : ('warning' as const),
      detail:
        expiredOrErrAccounts === 0
          ? `${accounts.length} account(s) healthy.`
          : `${expiredOrErrAccounts} account(s) require reconnection or attention.`,
    },
    {
      id: 'sessions',
      label: 'Active Session Hygiene',
      status: activeSessionCount <= 5 ? ('ok' as const) : ('warning' as const),
      detail: `${activeSessionCount} active session(s) across devices.`,
    },
    {
      id: 'e2ee_disclosure',
      label: 'End-to-End Encryption Disclosure',
      status: 'ok' as const,
      detail: 'Standard TLS & server-side AES-256-GCM storage encryption active (not PGP/S-MIME E2EE).',
    },
  ];

  res.json({
    posture,
    loginHistory: events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      severity: e.severity,
      ipAddress: e.ip_address,
      details: JSON.parse(e.details_json || '{}'),
      createdAt: e.created_at,
    })),
    oauthPermissions,
    storage: {
      totalBytes,
      attachmentsBytes: attBytesRow.total || 0,
      accounts: accounts.map((a) => ({
        id: a.id,
        emailAddress: a.email_address,
        usedBytes: a.used_bytes || 0,
        quotaMb: a.quota_mb || 1024,
      })),
    },
  });
});

authRouter.get('/export', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();

  const accounts = db
    .prepare('SELECT id, provider_type, email_address, display_name, status, last_synced_at, created_at FROM accounts WHERE user_id = ?')
    .all(auth.id);
  const threads = db.prepare('SELECT * FROM threads WHERE user_id = ?').all(auth.id);
  const messages = db
    .prepare(
      `SELECT id, thread_id, account_id, message_id_header, from_name, from_address, to_json, cc_json, subject, body_text, sent_at, received_at, is_read, is_starred, is_important
       FROM messages WHERE user_id = ?`
    )
    .all(auth.id);
  const contacts = db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(auth.id);
  const rules = db.prepare('SELECT * FROM rules WHERE user_id = ?').all(auth.id);
  const labels = db.prepare('SELECT * FROM labels WHERE user_id = ?').all(auth.id);
  const templates = db.prepare('SELECT * FROM templates WHERE user_id = ?').all(auth.id);
  const prefs = db.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?').get(auth.id) as
    | { preferences_json: string }
    | undefined;

  const bundle = {
    exportedAt: new Date().toISOString(),
    user: { id: auth.id, email: auth.email, name: auth.name },
    preferences: prefs ? JSON.parse(prefs.preferences_json) : null,
    accounts,
    threads,
    messages,
    contacts,
    rules,
    labels,
    templates,
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="cadence-data-export.json"');
  res.send(JSON.stringify(bundle, null, 2));
});

authRouter.delete('/account', requireAuth, (req, res) => {
  const auth = req.auth!;
  const db = getDb();
  const atts = db.prepare('SELECT storage_path FROM attachments WHERE user_id = ?').all(auth.id) as Array<{
    storage_path: string;
  }>;
  for (const att of atts) {
    try {
      if (fs.existsSync(att.storage_path)) fs.unlinkSync(att.storage_path);
    } catch {
      // ignore
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(auth.id);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});
