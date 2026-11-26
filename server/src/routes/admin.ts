import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { param, requireAdmin, requireAuth } from '../security/authMiddleware.js';
import { hashPassword } from '../security/crypto.js';
import { createHostedAccountForUser, ensureUserDefaults } from '../services/accountSetup.js';
import { createInfrastructureBackup, restoreBackup, verifyBackupIntegrity } from '../services/backupService.js';
import {
  createHostedDomain,
  listHostedDomains,
  rotateDomainDkimKey,
  verifyDomainDns,
} from '../services/domainService.js';
import {
  moveQueueJobToDeadLetter,
  processMailQueue,
  retryMailQueueJobNow,
} from '../services/mailDeliveryEngine.js';
import { eventBus } from '../services/eventBus.js';
import { getObservabilitySnapshot } from '../services/observabilityService.js';
import { recordSecurityEvent } from '../services/securityLogService.js';
import { getSmtpServiceStatus } from '../smtp/smtpServer.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/overview', (_req, res) => {
  const db = getDb();
  const usersStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
              SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
       FROM users`
    )
    .get() as Record<string, number | null>;

  const domainsStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN ownership_verified = 1 THEN 1 ELSE 0 END) AS dns_verified,
              SUM(CASE WHEN status = 'pending_verification' THEN 1 ELSE 0 END) AS pending
       FROM domains`
    )
    .get() as Record<string, number | null>;

  const accountsStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN provider_type IN ('hosted', 'local') OR account_ownership = 'hosted' THEN 1 ELSE 0 END) AS hosted,
              SUM(CASE WHEN account_ownership = 'external' THEN 1 ELSE 0 END) AS external,
              COALESCE(SUM(used_bytes), 0) AS storage_bytes
       FROM accounts`
    )
    .get() as Record<string, number | null>;

  const queueStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN status = 'retry_pending' THEN 1 ELSE 0 END) AS retry_pending,
              SUM(CASE WHEN status = 'accepted_by_mx' THEN 1 ELSE 0 END) AS accepted_mx,
              SUM(CASE WHEN status IN ('bounced', 'failed') THEN 1 ELSE 0 END) AS failed
       FROM mail_queue`
    )
    .get() as Record<string, number | null>;

  const logStats = db
    .prepare(
      `SELECT SUM(CASE WHEN direction = 'inbound' AND status = 'received' THEN 1 ELSE 0 END) AS inbound_ok,
              SUM(CASE WHEN direction = 'inbound' AND status = 'rejected_spam' THEN 1 ELSE 0 END) AS inbound_spam,
              SUM(CASE WHEN direction = 'outbound' AND status IN ('accepted_local', 'accepted_by_mx') THEN 1 ELSE 0 END) AS outbound_ok,
              SUM(CASE WHEN direction = 'outbound' AND status IN ('bounced', 'failed') THEN 1 ELSE 0 END) AS outbound_failed
       FROM mail_delivery_logs`
    )
    .get() as Record<string, number | null>;

  const aliasesCount = (db.prepare('SELECT COUNT(*) AS cnt FROM mailbox_aliases').get() as { cnt: number }).cnt;
  const securityCount = (db.prepare('SELECT COUNT(*) AS cnt FROM security_events').get() as { cnt: number }).cnt;
  const lastBackup = db
    .prepare('SELECT id, size_bytes, status, created_at FROM backup_records ORDER BY created_at DESC LIMIT 1')
    .get();

  let dbSizeBytes = 0;
  try {
    if (fs.existsSync(config.dbPath)) dbSizeBytes = fs.statSync(config.dbPath).size;
  } catch {
    // ignore
  }

  res.json({
    users: {
      total: usersStats.total || 0,
      active: usersStats.active || 0,
      suspended: usersStats.suspended || 0,
      admins: usersStats.admins || 0,
    },
    domains: {
      total: domainsStats.total || 0,
      active: domainsStats.active || 0,
      dnsVerified: domainsStats.dns_verified || 0,
      pending: domainsStats.pending || 0,
    },
    mailboxes: {
      total: accountsStats.total || 0,
      hosted: accountsStats.hosted || 0,
      external: accountsStats.external || 0,
      aliases: aliasesCount,
      storageBytes: accountsStats.storage_bytes || 0,
      dbSizeBytes,
    },
    queue: {
      total: queueStats.total || 0,
      queued: queueStats.queued || 0,
      retryPending: queueStats.retry_pending || 0,
      acceptedMx: queueStats.accepted_mx || 0,
      failed: queueStats.failed || 0,
    },
    traffic: {
      inboundDelivered: logStats.inbound_ok || 0,
      inboundSpamQuarantined: logStats.inbound_spam || 0,
      outboundDelivered: logStats.outbound_ok || 0,
      outboundFailed: logStats.outbound_failed || 0,
    },
    securityEventsTotal: securityCount,
    lastBackup: lastBackup || null,
    smtp: getSmtpServiceStatus(),
    observability: getObservabilitySnapshot(eventBus.getActiveClientCount()),
  });
});

adminRouter.get('/metrics', (_req, res) => {
  res.json({
    metrics: getObservabilitySnapshot(eventBus.getActiveClientCount()),
    smtp: getSmtpServiceStatus(),
  });
});

// --- DOMAINS & DNS ---
adminRouter.get('/domains', (_req, res) => {
  res.json({ domains: listHostedDomains(getDb()) });
});

adminRouter.post('/domains', (req, res) => {
  const schema = z.object({
    domain: z.string().trim().min(3).max(253),
    primaryMxHost: z.string().trim().max(253).optional(),
    dkimSelector: z.string().trim().max(40).optional(),
    activateInternal: z.boolean().optional().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid domain name required' });
    return;
  }

  try {
    const db = getDb();
    const created = createHostedDomain(db, req.auth!.id, parsed.data.domain, {
      primaryMxHost: parsed.data.primaryMxHost,
      dkimSelector: parsed.data.dkimSelector,
      activateInternal: parsed.data.activateInternal,
    });
    recordSecurityEvent({
      userId: req.auth!.id,
      eventType: 'domain_created',
      severity: 'info',
      actorEmail: req.auth!.email,
      details: { domain: created.domain, status: created.status },
    }, db);
    res.status(201).json({ domain: created });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to create domain' });
  }
});

adminRouter.post('/domains/:id/verify-dns', async (req, res) => {
  try {
    const domain = await verifyDomainDns(getDb(), param(req, 'id'));
    res.json({ domain });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'DNS verification failed' });
  }
});

adminRouter.post('/domains/:id/rotate-dkim', (req, res) => {
  try {
    const db = getDb();
    const domain = rotateDomainDkimKey(db, param(req, 'id'));
    recordSecurityEvent({
      userId: req.auth!.id,
      eventType: 'dkim_rotated',
      severity: 'warning',
      actorEmail: req.auth!.email,
      details: { domain: domain.domain },
    }, db);
    res.json({ domain });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Unable to rotate DKIM key' });
  }
});

adminRouter.patch('/domains/:id', (req, res) => {
  const schema = z.object({
    status: z.enum(['active', 'disabled', 'pending_verification']).optional(),
    internalOnly: z.boolean().optional(),
    primaryMxHost: z.string().trim().min(3).max(253).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid domain update payload' });
    return;
  }

  const db = getDb();
  const id = param(req, 'id');
  const existing = db.prepare('SELECT * FROM domains WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Domain not found' });
    return;
  }

  const d = parsed.data;
  const now = new Date().toISOString();
  const nextStatus = d.status ?? existing.status;
  const nextInternal =
    d.internalOnly !== undefined
      ? d.internalOnly
        ? 1
        : 0
      : nextStatus === 'active' && !existing.ownership_verified
      ? 1
      : existing.internal_only;
  const nextMx = d.primaryMxHost ? d.primaryMxHost.toLowerCase() : existing.primary_mx_host;

  db.prepare(
    'UPDATE domains SET status = ?, internal_only = ?, primary_mx_host = ?, updated_at = ? WHERE id = ?'
  ).run(nextStatus, nextInternal, nextMx, now, id);

  res.json({ domain: listHostedDomains(db).find((dom) => dom.id === id) });
});

adminRouter.delete('/domains/:id', (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  const existing = db.prepare('SELECT domain FROM domains WHERE id = ?').get(id) as { domain: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Domain not found' });
    return;
  }
  db.prepare('DELETE FROM domains WHERE id = ?').run(id);
  recordSecurityEvent({
    userId: req.auth!.id,
    eventType: 'domain_deleted',
    severity: 'warning',
    actorEmail: req.auth!.email,
    details: { domain: existing.domain },
  }, db);
  res.json({ ok: true });
});

// --- USERS, HOSTED MAILBOXES & ALIASES ---
adminRouter.get('/users', (_req, res) => {
  const db = getDb();
  const users = db
    .prepare('SELECT id, email, name, role, status, quota_mb, created_at, updated_at FROM users ORDER BY created_at ASC')
    .all() as Array<Record<string, any>>;

  // Only list metadata/status of accounts; never expose external message contents or encrypted credentials
  const hostedStmt = db.prepare(
    `SELECT id, domain_id, provider_type, email_address, display_name, status, quota_mb, used_bytes, created_at
     FROM accounts WHERE user_id = ? AND (provider_type IN ('hosted', 'local') OR account_ownership = 'hosted')`
  );
  const extCountStmt = db.prepare(
    "SELECT COUNT(*) AS cnt FROM accounts WHERE user_id = ? AND account_ownership = 'external'"
  );
  const aliasStmt = db.prepare('SELECT id, account_id, domain_id, alias_address, created_at FROM mailbox_aliases WHERE user_id = ?');

  res.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      quotaMb: u.quota_mb,
      createdAt: u.created_at,
      hostedMailboxes: hostedStmt.all(u.id),
      externalAccountCount: (extCountStmt.get(u.id) as { cnt: number }).cnt,
      aliases: aliasStmt.all(u.id),
    })),
  });
});

adminRouter.post('/users', (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
    role: z.enum(['admin', 'member']).default('member'),
    quotaMb: z.number().int().min(10).max(102400).default(1024),
    domainId: z.string().optional(),
    mailboxAddress: z.string().trim().email().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid name, email, and 8+ character password are required.' });
    return;
  }

  const db = getDb();
  const d = parsed.data;
  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(d.email)) {
    res.status(409).json({ error: 'User with this email already exists' });
    return;
  }

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, quota_mb, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
  ).run(userId, d.email.toLowerCase(), d.name, hashPassword(d.password), d.role, d.quotaMb, now, now);
  ensureUserDefaults(db, userId);

  let mailboxId: string | null = null;
  if (d.mailboxAddress || d.domainId) {
    const targetAddr = (d.mailboxAddress || d.email).toLowerCase();
    mailboxId = createHostedAccountForUser(db, userId, targetAddr, d.name, {
      domainId: d.domainId || null,
      quotaMb: d.quotaMb,
      providerType: 'hosted',
    });
  }

  recordSecurityEvent({
    userId: req.auth!.id,
    eventType: 'admin_user_created',
    severity: 'info',
    actorEmail: req.auth!.email,
    details: { createdEmail: d.email.toLowerCase(), role: d.role, mailboxId },
  }, db);

  res.status(201).json({ userId, mailboxId });
});

adminRouter.patch('/users/:id', (req, res) => {
  const schema = z.object({
    role: z.enum(['admin', 'member']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    quotaMb: z.number().int().min(10).max(102400).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid user update' });
    return;
  }

  const db = getDb();
  const id = param(req, 'id');
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (id === req.auth!.id && (parsed.data.status === 'suspended' || parsed.data.role === 'member')) {
    res.status(400).json({ error: 'Administrators cannot suspend or demote their own current session.' });
    return;
  }

  const d = parsed.data;
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET role = ?, status = ?, quota_mb = ?, updated_at = ? WHERE id = ?').run(
    d.role ?? existing.role,
    d.status ?? existing.status,
    d.quotaMb ?? existing.quota_mb,
    now,
    id
  );

  if (d.quotaMb !== undefined) {
    db.prepare("UPDATE accounts SET quota_mb = ?, updated_at = ? WHERE user_id = ? AND provider_type IN ('hosted', 'local')").run(
      d.quotaMb,
      now,
      id
    );
  }
  if (d.status !== undefined) {
    db.prepare(
      "UPDATE accounts SET status = ?, updated_at = ? WHERE user_id = ? AND provider_type IN ('hosted', 'local')"
    ).run(d.status === 'suspended' ? 'suspended' : 'connected', now, id);
    if (d.status === 'suspended') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  }

  recordSecurityEvent({
    userId: req.auth!.id,
    eventType: 'admin_user_updated',
    severity: 'warning',
    actorEmail: req.auth!.email,
    details: { targetUserId: id, ...d },
  }, db);

  res.json({ ok: true });
});

adminRouter.delete('/users/:id', (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  if (id === req.auth!.id) {
    res.status(400).json({ error: 'Cannot delete your own active administrator account.' });
    return;
  }
  const resDel = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (resDel.changes === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  recordSecurityEvent({
    userId: req.auth!.id,
    eventType: 'admin_user_deleted',
    severity: 'high',
    actorEmail: req.auth!.email,
    details: { deletedUserId: id },
  }, db);
  res.json({ ok: true });
});

adminRouter.post('/aliases', (req, res) => {
  const schema = z.object({
    accountId: z.string().min(1),
    aliasAddress: z.string().trim().email(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid mailbox and alias email address required' });
    return;
  }

  const db = getDb();
  const acct = db
    .prepare("SELECT id, user_id FROM accounts WHERE id = ? AND provider_type IN ('hosted', 'local')")
    .get(parsed.data.accountId) as { id: string; user_id: string } | undefined;
  if (!acct) {
    res.status(404).json({ error: 'Hosted mailbox not found' });
    return;
  }

  const alias = parsed.data.aliasAddress.toLowerCase();
  const domPart = alias.split('@')[1] || '';
  const dom = db.prepare('SELECT id FROM domains WHERE lower(domain) = lower(?) LIMIT 1').get(domPart) as
    | { id: string }
    | undefined;

  if (
    db.prepare('SELECT id FROM mailbox_aliases WHERE lower(alias_address) = lower(?)').get(alias) ||
    db.prepare("SELECT id FROM accounts WHERE provider_type IN ('hosted', 'local') AND lower(email_address) = lower(?)").get(alias)
  ) {
    res.status(409).json({ error: `Address ${alias} is already assigned` });
    return;
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO mailbox_aliases (id, domain_id, account_id, user_id, alias_address, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    dom?.id ?? null,
    acct.id,
    acct.user_id,
    alias,
    new Date().toISOString()
  );
  res.status(201).json({ id, aliasAddress: alias });
});

adminRouter.delete('/aliases/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM mailbox_aliases WHERE id = ?').run(param(req, 'id'));
  res.json({ ok: true });
});

// --- QUEUE, DELIVERY LOGS & SECURITY EVENTS ---
adminRouter.get('/queue', (req, res) => {
  const db = getDb();
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? db.prepare('SELECT * FROM mail_queue WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status)
    : db.prepare('SELECT * FROM mail_queue ORDER BY created_at DESC LIMIT 100').all();
  res.json({ queue: rows });
});

adminRouter.post('/queue/:id/retry', async (req, res) => {
  const db = getDb();
  const ok = retryMailQueueJobNow(db, param(req, 'id'));
  if (!ok) {
    res.status(404).json({ error: 'Queue job cannot be retried (missing raw payload or already completed)' });
    return;
  }
  await processMailQueue(db);
  res.json({ ok: true });
});

adminRouter.post('/queue/:id/dead-letter', (req, res) => {
  const db = getDb();
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : undefined;
  const ok = moveQueueJobToDeadLetter(db, param(req, 'id'), reason);
  if (!ok) {
    res.status(404).json({ error: 'Queue job not found or already finalized' });
    return;
  }
  res.json({ ok: true });
});

adminRouter.delete('/queue/:id', (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  const row = db.prepare('SELECT raw_mime_path FROM mail_queue WHERE id = ?').get(id) as
    | { raw_mime_path: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Queue job not found' });
    return;
  }
  try {
    if (row.raw_mime_path && fs.existsSync(row.raw_mime_path)) fs.unlinkSync(row.raw_mime_path);
  } catch {
    // ignore
  }
  db.prepare('DELETE FROM mail_queue WHERE id = ?').run(id);
  res.json({ ok: true });
});

adminRouter.get('/delivery-logs', (req, res) => {
  const db = getDb();
  const direction = req.query.direction ? String(req.query.direction) : null;
  const rows = direction
    ? db
        .prepare('SELECT * FROM mail_delivery_logs WHERE direction = ? ORDER BY created_at DESC LIMIT 120')
        .all(direction)
    : db.prepare('SELECT * FROM mail_delivery_logs ORDER BY created_at DESC LIMIT 120').all();
  res.json({ logs: rows });
});

adminRouter.get('/security-events', (_req, res) => {
  const db = getDb();
  const events = db.prepare('SELECT * FROM security_events ORDER BY created_at DESC LIMIT 120').all();
  res.json({ events });
});

// --- BACKUPS & RECOVERY ---
adminRouter.get('/backups', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC').all() as Array<Record<string, any>>;
  res.json({
    backups: rows.map((b) => ({
      id: b.id,
      backupPath: b.backup_path,
      sizeBytes: b.size_bytes,
      includeAttachments: Boolean(b.include_attachments),
      status: b.status,
      checksumSha256: b.checksum_sha256,
      manifest: JSON.parse(b.manifest_json || '{}'),
      createdAt: b.created_at,
    })),
  });
});

adminRouter.post('/backups', (req, res) => {
  const includeAttachments = req.body?.includeAttachments !== false;
  const created = createInfrastructureBackup(getDb(), req.auth!.id, { includeAttachments });
  res.status(201).json({ backup: created });
});

adminRouter.post('/backups/:id/verify', (req, res) => {
  try {
    const result = verifyBackupIntegrity(getDb(), param(req, 'id'));
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Backup verification failed' });
  }
});

adminRouter.post('/backups/:id/restore', (req, res) => {
  try {
    const dryRun = Boolean(req.body?.dryRun);
    const result = restoreBackup(getDb(), param(req, 'id'), req.auth!.id, { dryRun });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed' });
  }
});

adminRouter.delete('/backups/:id', (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  const row = db.prepare('SELECT backup_path FROM backup_records WHERE id = ?').get(id) as
    | { backup_path: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Backup not found' });
    return;
  }
  try {
    if (fs.existsSync(row.backup_path)) fs.rmSync(row.backup_path, { recursive: true, force: true });
  } catch {
    // ignore
  }
  db.prepare('DELETE FROM backup_records WHERE id = ?').run(id);
  res.json({ ok: true });
});
