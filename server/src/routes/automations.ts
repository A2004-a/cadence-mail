import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import {
  computeNextRunAt,
  executeScheduledAutomationRow,
  isValidTimeZone,
  normalizeGoogleMapsUrl,
  renderAutomationTextToHtml,
  type InfoProfileRow,
  type ScheduledAutomationRow,
} from '../services/automationService.js';
import { dispatchDraftNow } from '../services/sendService.js';
import { storeAttachmentBuffer } from '../services/threadService.js';

export const automationsRouter = Router();
automationsRouter.use(requireAuth);

const participantSchema = z.object({
  name: z.string().default(''),
  address: z.string().trim().email(),
});

function ownershipFilteredAssetIds(db: ReturnType<typeof getDb>, userId: string, candidateIds: string[]): string[] {
  if (!candidateIds.length) return [];
  const rows = db
    .prepare('SELECT id FROM automation_assets WHERE user_id = ?')
    .all(userId) as Array<{ id: string }>;
  const owned = new Set(rows.map((r) => r.id));
  return Array.from(new Set(candidateIds.filter((id) => owned.has(id))));
}

function ownershipFilteredProfileIds(db: ReturnType<typeof getDb>, userId: string, candidateIds: string[]): string[] {
  if (!candidateIds.length) return [];
  const rows = db
    .prepare('SELECT id FROM automation_info_profiles WHERE user_id = ?')
    .all(userId) as Array<{ id: string }>;
  const owned = new Set(rows.map((r) => r.id));
  return Array.from(new Set(candidateIds.filter((id) => owned.has(id))));
}

function hydrateAssetsById(db: ReturnType<typeof getDb>, userId: string) {
  const rows = db
    .prepare('SELECT id, name, filename, mime_type, size_bytes, created_at FROM automation_assets WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Array<{
    id: string;
    name: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    created_at: string;
  }>;
  const map = new Map<
    string,
    { id: string; name: string; filename: string; mimeType: string; sizeBytes: number; createdAt: string }
  >();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      name: r.name || r.filename,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    });
  }
  return map;
}

// --- REUSABLE AUTOMATION ATTACHMENTS VAULT ---

automationsRouter.get('/assets', (req, res) => {
  const db = getDb();
  const assetMap = hydrateAssetsById(db, req.auth!.id);
  res.json({ assets: Array.from(assetMap.values()) });
});

const uploadAssetSchema = z.object({
  name: z.string().trim().max(120).optional(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(20_500_000),
});

automationsRouter.post('/assets', (req, res) => {
  const parsed = uploadAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid automation file upload payload' });
    return;
  }

  const buf = Buffer.from(parsed.data.contentBase64, 'base64');
  if (buf.byteLength > 15 * 1024 * 1024) {
    res.status(413).json({ error: 'File exceeds 15 MB automation limit' });
    return;
  }

  const userId = req.auth!.id;
  const stored = storeAttachmentBuffer(userId, parsed.data.filename, parsed.data.mimeType, buf, {});
  const now = new Date().toISOString();
  const db = getDb();
  const cleanName = parsed.data.name?.trim() || parsed.data.filename;

  db.prepare(
    `INSERT INTO automation_assets (id, user_id, name, filename, mime_type, size_bytes, storage_path, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(stored.id, userId, cleanName, parsed.data.filename, parsed.data.mimeType, stored.sizeBytes, stored.storagePath, stored.sha256, now);

  res.status(201).json({
    asset: {
      id: stored.id,
      name: cleanName,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      sizeBytes: stored.sizeBytes,
      createdAt: now,
    },
  });
});

automationsRouter.get('/assets/:id', (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT filename, mime_type, storage_path FROM automation_assets WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as { filename: string; mime_type: string; storage_path: string } | undefined;

  if (!row || !fs.existsSync(row.storage_path)) {
    res.status(404).json({ error: 'Automation file not found' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/["\r\n]/g, '_')}"`);
  res.send(fs.readFileSync(row.storage_path));
});

automationsRouter.delete('/assets/:id', (req, res) => {
  const db = getDb();
  const id = param(req, 'id');
  const userId = req.auth!.id;
  const row = db
    .prepare('SELECT id, storage_path FROM automation_assets WHERE id = ? AND user_id = ?')
    .get(id, userId) as { id: string; storage_path: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Automation file not found' });
    return;
  }

  if (row.storage_path && fs.existsSync(row.storage_path)) {
    try {
      fs.unlinkSync(row.storage_path);
    } catch {
      // ignore unlink error
    }
  }
  db.prepare('DELETE FROM automation_assets WHERE id = ? AND user_id = ?').run(id, userId);

  // Strip removed asset id cleanly from info profiles & scheduled automations
  const profiles = db
    .prepare('SELECT id, attachment_ids_json FROM automation_info_profiles WHERE user_id = ?')
    .all(userId) as Array<{ id: string; attachment_ids_json: string }>;
  for (const p of profiles) {
    const ids = (JSON.parse(p.attachment_ids_json || '[]') as string[]).filter((x) => x !== id);
    db.prepare('UPDATE automation_info_profiles SET attachment_ids_json = ? WHERE id = ?').run(JSON.stringify(ids), p.id);
  }
  const scheds = db
    .prepare('SELECT id, attachment_ids_json FROM scheduled_automations WHERE user_id = ?')
    .all(userId) as Array<{ id: string; attachment_ids_json: string }>;
  for (const s of scheds) {
    const ids = (JSON.parse(s.attachment_ids_json || '[]') as string[]).filter((x) => x !== id);
    db.prepare('UPDATE scheduled_automations SET attachment_ids_json = ? WHERE id = ?').run(JSON.stringify(ids), s.id);
  }

  res.json({ ok: true });
});

// --- SHARED INFO PROFILES VAULT (GOOGLE MAPS LOCATION, CONTACT CARDS, DOC PACKS) ---

function formatInfoProfile(row: InfoProfileRow, assetMap: Map<string, any>) {
  const attIds = JSON.parse(row.attachment_ids_json || '[]') as string[];
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    contentText: row.content_text,
    mapQuery: row.map_query,
    mapUrl: row.map_url,
    effectiveMapUrl: normalizeGoogleMapsUrl(row.map_query, row.map_url),
    attachmentIds: attIds,
    attachments: attIds.map((aid) => assetMap.get(aid)).filter(Boolean),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

automationsRouter.get('/info', (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const assetMap = hydrateAssetsById(db, userId);
  const rows = db
    .prepare('SELECT * FROM automation_info_profiles WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as unknown as InfoProfileRow[];
  res.json({ profiles: rows.map((r) => formatInfoProfile(r, assetMap)) });
});

const infoProfileSchema = z.object({
  slug: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(['location', 'contact', 'document', 'custom']).default('custom'),
  title: z.string().trim().min(1).max(120),
  contentText: z.string().max(10_000).default(''),
  mapQuery: z.string().max(400).default(''),
  mapUrl: z.string().max(1000).default(''),
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
});

automationsRouter.post('/info', (req, res) => {
  const parsed = infoProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid shared information profile payload' });
    return;
  }

  const d = parsed.data;
  if (d.mapUrl.trim() && !/^https?:\/\/\S+$/i.test(d.mapUrl.trim())) {
    res.status(400).json({ error: 'Google Maps / URL link must start with http:// or https://' });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const baseSlug = (d.slug || (d.kind === 'location' ? 'location' : d.title))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'info';

  let finalSlug = baseSlug;
  let suffix = 2;
  while (
    db
      .prepare('SELECT id FROM automation_info_profiles WHERE user_id = ? AND lower(slug) = lower(?)')
      .get(userId, finalSlug)
  ) {
    finalSlug = `${baseSlug}-${suffix++}`;
  }

  const validAttIds = ownershipFilteredAssetIds(db, userId, d.attachmentIds);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO automation_info_profiles (id, user_id, slug, kind, title, content_text, map_query, map_url, attachment_ids_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    finalSlug,
    d.kind,
    d.title,
    d.contentText,
    d.mapQuery,
    d.mapUrl.trim(),
    JSON.stringify(validAttIds),
    now,
    now
  );

  const row = db.prepare('SELECT * FROM automation_info_profiles WHERE id = ?').get(id) as unknown as InfoProfileRow;
  res.status(201).json({ profile: formatInfoProfile(row, hydrateAssetsById(db, userId)) });
});

automationsRouter.patch('/info/:id', (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const existing = db
    .prepare('SELECT * FROM automation_info_profiles WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), userId) as unknown as InfoProfileRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Shared info profile not found' });
    return;
  }

  const parsed = infoProfileSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid shared info update' });
    return;
  }
  const d = parsed.data;
  if (d.mapUrl && d.mapUrl.trim() && !/^https?:\/\/\S+$/i.test(d.mapUrl.trim())) {
    res.status(400).json({ error: 'Google Maps / URL link must start with http:// or https://' });
    return;
  }

  const validAttIds =
    d.attachmentIds !== undefined
      ? ownershipFilteredAssetIds(db, userId, d.attachmentIds)
      : JSON.parse(existing.attachment_ids_json || '[]');

  const nextSlug = d.slug
    ? d.slug
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || existing.slug
    : existing.slug;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE automation_info_profiles
     SET slug = ?, kind = ?, title = ?, content_text = ?, map_query = ?, map_url = ?, attachment_ids_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    nextSlug,
    d.kind ?? existing.kind,
    d.title ?? existing.title,
    d.contentText ?? existing.content_text,
    d.mapQuery ?? existing.map_query,
    d.mapUrl !== undefined ? d.mapUrl.trim() : existing.map_url,
    JSON.stringify(validAttIds),
    now,
    existing.id,
    userId
  );

  const updated = db
    .prepare('SELECT * FROM automation_info_profiles WHERE id = ?')
    .get(existing.id) as unknown as InfoProfileRow;
  res.json({ profile: formatInfoProfile(updated, hydrateAssetsById(db, userId)) });
});

automationsRouter.delete('/info/:id', (req, res) => {
  const db = getDb();
  const resDel = db
    .prepare('DELETE FROM automation_info_profiles WHERE id = ? AND user_id = ?')
    .run(param(req, 'id'), req.auth!.id);
  if (resDel.changes === 0) {
    res.status(404).json({ error: 'Shared info profile not found' });
    return;
  }
  res.json({ ok: true });
});

// --- RECURRING SCHEDULED AUTOMATIONS (e.g. DAILY 5:00 AM WITH ATTACHMENTS) ---

const scheduledSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  frequency: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'interval_hours']).default('daily'),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be HH:MM (24h)')
    .default('05:00'),
  timezone: z.string().trim().min(1).max(80).default('UTC'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  intervalHours: z.number().int().min(1).max(168).default(24),
  to: z.array(participantSchema).min(1, 'At least one To recipient is required'),
  cc: z.array(participantSchema).default([]),
  bcc: z.array(participantSchema).default([]),
  subject: z.string().trim().min(1).max(480),
  bodyText: z.string().max(100_000).default(''),
  infoProfileIds: z.array(z.string().min(1)).max(20).default([]),
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
  maxRuns: z.number().int().min(1).max(10_000).nullable().optional(),
});

function formatScheduledAutomation(
  row: ScheduledAutomationRow,
  assetMap: Map<string, any>,
  accountEmailMap: Map<string, string>
) {
  const attIds = JSON.parse(row.attachment_ids_json || '[]') as string[];
  const infoIds = JSON.parse(row.info_profile_ids_json || '[]') as string[];
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: accountEmailMap.get(row.account_id) || '',
    name: row.name,
    enabled: Boolean(row.enabled),
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    timezone: row.timezone,
    daysOfWeek: JSON.parse(row.days_of_week_json || '[0,1,2,3,4,5,6]'),
    dayOfMonth: row.day_of_month,
    intervalHours: row.interval_hours,
    to: JSON.parse(row.to_json || '[]'),
    cc: JSON.parse(row.cc_json || '[]'),
    bcc: JSON.parse(row.bcc_json || '[]'),
    subject: row.subject,
    bodyText: row.body_text,
    infoProfileIds: infoIds,
    attachmentIds: attIds,
    attachments: attIds.map((aid) => assetMap.get(aid)).filter(Boolean),
    maxRuns: row.max_runs,
    runCount: row.run_count,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

automationsRouter.get('/scheduled', (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const assetMap = hydrateAssetsById(db, userId);
  const accts = db
    .prepare('SELECT id, email_address FROM accounts WHERE user_id = ?')
    .all(userId) as Array<{ id: string; email_address: string }>;
  const acctEmailMap = new Map(accts.map((a) => [a.id, a.email_address]));

  const rows = db
    .prepare('SELECT * FROM scheduled_automations WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as unknown as ScheduledAutomationRow[];

  const logs = db
    .prepare(
      `SELECT l.id, l.automation_id, sa.name AS automation_name, l.draft_id, l.status, l.detail, l.executed_at
       FROM scheduled_automation_logs l
       LEFT JOIN scheduled_automations sa ON sa.id = l.automation_id
       WHERE l.user_id = ?
       ORDER BY l.executed_at DESC
       LIMIT 60`
    )
    .all(userId) as Array<{
    id: string;
    automation_id: string;
    automation_name: string | null;
    draft_id: string | null;
    status: string;
    detail: string;
    executed_at: string;
  }>;

  res.json({
    automations: rows.map((r) => formatScheduledAutomation(r, assetMap, acctEmailMap)),
    logs: logs.map((lg) => ({
      id: lg.id,
      automationId: lg.automation_id,
      automationName: lg.automation_name,
      draftId: lg.draft_id,
      status: lg.status,
      detail: lg.detail,
      executedAt: lg.executed_at,
    })),
  });
});

automationsRouter.post('/scheduled', (req, res) => {
  const parsed = scheduledSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid scheduled automation' });
    return;
  }

  const d = parsed.data;
  if (!isValidTimeZone(d.timezone)) {
    res.status(400).json({ error: `Invalid IANA timezone: ${d.timezone}` });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const acct = db
    .prepare('SELECT id, email_address FROM accounts WHERE id = ? AND user_id = ?')
    .get(d.accountId, userId) as { id: string; email_address: string } | undefined;
  if (!acct) {
    res.status(404).json({ error: 'Selected sending account not found' });
    return;
  }

  const assetIds = ownershipFilteredAssetIds(db, userId, d.attachmentIds);
  const infoIds = ownershipFilteredProfileIds(db, userId, d.infoProfileIds);
  const nextRunAt = computeNextRunAt({
    frequency: d.frequency,
    timeOfDay: d.timeOfDay,
    timezone: d.timezone,
    daysOfWeek: d.daysOfWeek,
    dayOfMonth: d.dayOfMonth,
    intervalHours: d.intervalHours,
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scheduled_automations (
      id, user_id, account_id, name, enabled, frequency, time_of_day, timezone,
      days_of_week_json, day_of_month, interval_hours, to_json, cc_json, bcc_json,
      subject, body_text, body_html, info_profile_ids_json, attachment_ids_json,
      max_runs, run_count, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    userId,
    d.accountId,
    d.name,
    d.enabled ? 1 : 0,
    d.frequency,
    d.timeOfDay,
    d.timezone,
    JSON.stringify(d.daysOfWeek),
    d.dayOfMonth,
    d.intervalHours,
    JSON.stringify(d.to),
    JSON.stringify(d.cc),
    JSON.stringify(d.bcc),
    d.subject,
    d.bodyText,
    renderAutomationTextToHtml(d.bodyText),
    JSON.stringify(infoIds),
    JSON.stringify(assetIds),
    d.maxRuns ?? null,
    nextRunAt,
    now,
    now
  );

  const row = db.prepare('SELECT * FROM scheduled_automations WHERE id = ?').get(id) as unknown as ScheduledAutomationRow;
  res.status(201).json({
    automation: formatScheduledAutomation(row, hydrateAssetsById(db, userId), new Map([[acct.id, acct.email_address]])),
  });
});

automationsRouter.patch('/scheduled/:id', (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const existing = db
    .prepare('SELECT * FROM scheduled_automations WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), userId) as unknown as ScheduledAutomationRow | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Scheduled automation not found' });
    return;
  }

  const parsed = scheduledSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid scheduled automation update' });
    return;
  }

  const d = parsed.data;
  const tz = d.timezone ?? existing.timezone;
  if (!isValidTimeZone(tz)) {
    res.status(400).json({ error: `Invalid IANA timezone: ${tz}` });
    return;
  }

  const acctId = d.accountId ?? existing.account_id;
  const acct = db
    .prepare('SELECT id, email_address FROM accounts WHERE id = ? AND user_id = ?')
    .get(acctId, userId) as { id: string; email_address: string } | undefined;
  if (!acct) {
    res.status(404).json({ error: 'Selected sending account not found' });
    return;
  }

  const freq = d.frequency ?? existing.frequency;
  const timeOfDay = d.timeOfDay ?? existing.time_of_day;
  const daysOfWeek = d.daysOfWeek ?? (JSON.parse(existing.days_of_week_json || '[0,1,2,3,4,5,6]') as number[]);
  const dayOfMonth = d.dayOfMonth ?? existing.day_of_month;
  const intervalHours = d.intervalHours ?? existing.interval_hours;
  const nextRunAt = computeNextRunAt({
    frequency: freq,
    timeOfDay,
    timezone: tz,
    daysOfWeek,
    dayOfMonth,
    intervalHours,
  });

  const assetIds =
    d.attachmentIds !== undefined
      ? ownershipFilteredAssetIds(db, userId, d.attachmentIds)
      : JSON.parse(existing.attachment_ids_json || '[]');
  const infoIds =
    d.infoProfileIds !== undefined
      ? ownershipFilteredProfileIds(db, userId, d.infoProfileIds)
      : JSON.parse(existing.info_profile_ids_json || '[]');

  const bodyText = d.bodyText ?? existing.body_text;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE scheduled_automations
     SET account_id = ?, name = ?, enabled = ?, frequency = ?, time_of_day = ?, timezone = ?,
         days_of_week_json = ?, day_of_month = ?, interval_hours = ?, to_json = ?, cc_json = ?, bcc_json = ?,
         subject = ?, body_text = ?, body_html = ?, info_profile_ids_json = ?, attachment_ids_json = ?,
         max_runs = ?, next_run_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    acctId,
    d.name ?? existing.name,
    d.enabled !== undefined ? (d.enabled ? 1 : 0) : existing.enabled,
    freq,
    timeOfDay,
    tz,
    JSON.stringify(daysOfWeek),
    dayOfMonth,
    intervalHours,
    d.to ? JSON.stringify(d.to) : existing.to_json,
    d.cc ? JSON.stringify(d.cc) : existing.cc_json,
    d.bcc ? JSON.stringify(d.bcc) : existing.bcc_json,
    d.subject ?? existing.subject,
    bodyText,
    renderAutomationTextToHtml(bodyText),
    JSON.stringify(infoIds),
    JSON.stringify(assetIds),
    d.maxRuns !== undefined ? d.maxRuns : existing.max_runs,
    nextRunAt,
    now,
    existing.id,
    userId
  );

  const updated = db
    .prepare('SELECT * FROM scheduled_automations WHERE id = ?')
    .get(existing.id) as unknown as ScheduledAutomationRow;
  res.json({
    automation: formatScheduledAutomation(updated, hydrateAssetsById(db, userId), new Map([[acct.id, acct.email_address]])),
  });
});

automationsRouter.post('/scheduled/:id/run', async (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const row = db
    .prepare('SELECT * FROM scheduled_automations WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), userId) as unknown as ScheduledAutomationRow | undefined;

  if (!row) {
    res.status(404).json({ error: 'Scheduled automation not found' });
    return;
  }

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE scheduled_automations SET run_count = run_count + 1, updated_at = ? WHERE id = ?').run(nowIso, row.id);
  const result = await executeScheduledAutomationRow(db, row, dispatchDraftNow, { manualRun: true });
  res.status(result.ok ? 200 : 400).json(result);
});

automationsRouter.delete('/scheduled/:id', (req, res) => {
  const db = getDb();
  const resDel = db
    .prepare('DELETE FROM scheduled_automations WHERE id = ? AND user_id = ?')
    .run(param(req, 'id'), req.auth!.id);
  if (resDel.changes === 0) {
    res.status(404).json({ error: 'Scheduled automation not found' });
    return;
  }
  res.json({ ok: true });
});
