import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import { htmlToPlainText, sanitizeComposerHtml } from '../security/sanitize.js';
import { dispatchDraftNow } from '../services/sendService.js';
import { storeAttachmentBuffer } from '../services/threadService.js';

export const draftsRouter = Router();

const participantSchema = z.object({
  name: z.string().default(''),
  address: z.string().trim().email(),
});

const createDraftSchema = z.object({
  accountId: z.string().min(1),
  threadId: z.string().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  mode: z.enum(['new', 'reply', 'reply_all', 'forward']).default('new'),
  to: z.array(participantSchema).default([]),
  cc: z.array(participantSchema).default([]),
  bcc: z.array(participantSchema).default([]),
  subject: z.string().max(500).default(''),
  bodyHtml: z.string().max(500_000).default(''),
  bodyText: z.string().max(500_000).default(''),
  isPlainText: z.boolean().default(false),
});

const patchDraftSchema = z.object({
  accountId: z.string().min(1).optional(),
  to: z.array(participantSchema).optional(),
  cc: z.array(participantSchema).optional(),
  bcc: z.array(participantSchema).optional(),
  subject: z.string().max(500).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  bodyText: z.string().max(500_000).optional(),
  isPlainText: z.boolean().optional(),
  expectedVersion: z.number().int().optional(),
});

function formatDraftRow(db: ReturnType<typeof getDb>, row: Record<string, any>) {
  const attachments = db
    .prepare('SELECT id, filename, mime_type, size_bytes, content_id, is_inline FROM attachments WHERE draft_id = ?')
    .all(row.id) as Array<Record<string, any>>;

  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    replyToMessageId: row.reply_to_message_id,
    mode: row.mode,
    to: JSON.parse(row.to_json || '[]'),
    cc: JSON.parse(row.cc_json || '[]'),
    bcc: JSON.parse(row.bcc_json || '[]'),
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    isPlainText: Boolean(row.is_plain_text),
    status: row.status,
    scheduledFor: row.scheduled_for,
    scheduledTimezone: row.scheduled_timezone,
    undoSendUntil: row.undo_send_until,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      contentId: a.content_id,
      isInline: Boolean(a.is_inline),
    })),
  };
}

draftsRouter.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM drafts
       WHERE user_id = ? AND status IN ('draft', 'queued_undo', 'scheduled', 'sending', 'failed')
       ORDER BY updated_at DESC`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({ drafts: rows.map((r) => formatDraftRow(db, r)) });
});

draftsRouter.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | Record<string, any>
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }
  res.json({ draft: formatDraftRow(db, row) });
});

draftsRouter.post('/', requireAuth, (req, res) => {
  const parsed = createDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid draft payload', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const d = parsed.data;

  const account = db.prepare('SELECT id, status FROM accounts WHERE id = ? AND user_id = ?').get(d.accountId, userId) as
    | { id: string; status: string }
    | undefined;
  if (!account) {
    res.status(404).json({ error: 'Sending account not found' });
    return;
  }
  if (account.status === 'suspended') {
    res.status(403).json({ error: 'This mailbox is suspended' });
    return;
  }

  // Account isolation: only link threadId if the target thread actually belongs to the same account & user
  let scopedThreadId: string | null = null;
  if (d.threadId) {
    const ownedThread = db
      .prepare('SELECT id FROM threads WHERE id = ? AND user_id = ? AND account_id = ?')
      .get(d.threadId, userId, d.accountId) as { id: string } | undefined;
    if (ownedThread) scopedThreadId = ownedThread.id;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cleanHtml = sanitizeComposerHtml(d.bodyHtml);
  const text = d.bodyText || htmlToPlainText(cleanHtml);

  db.prepare(
    `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`
  ).run(
    id,
    userId,
    d.accountId,
    scopedThreadId,
    d.replyToMessageId || null,
    d.mode,
    JSON.stringify(d.to),
    JSON.stringify(d.cc),
    JSON.stringify(d.bcc),
    d.subject,
    cleanHtml,
    text,
    d.isPlainText ? 1 : 0,
    now,
    now
  );

  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Record<string, any>;
  res.status(201).json({ draft: formatDraftRow(db, row) });
});

draftsRouter.patch('/:id', requireAuth, (req, res) => {
  const id = param(req, 'id');
  const parsed = patchDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid draft update', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const existing = db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(id, userId) as
    | Record<string, any>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  if (existing.status === 'sending' || existing.status === 'sent') {
    res.status(409).json({ error: 'Draft has already been sent' });
    return;
  }

  const d = parsed.data;
  if (d.expectedVersion !== undefined && d.expectedVersion < existing.version) {
    res.status(409).json({ error: 'Draft conflict: newer revision exists on server', draft: formatDraftRow(db, existing) });
    return;
  }

  const now = new Date().toISOString();
  const nextHtml = d.bodyHtml !== undefined ? sanitizeComposerHtml(d.bodyHtml) : existing.body_html;
  const nextText =
    d.bodyText !== undefined ? d.bodyText : d.bodyHtml !== undefined ? htmlToPlainText(nextHtml) : existing.body_text;

  db.prepare(
    `UPDATE drafts
     SET account_id = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_html = ?, body_text = ?,
         is_plain_text = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    d.accountId ?? existing.account_id,
    d.to ? JSON.stringify(d.to) : existing.to_json,
    d.cc ? JSON.stringify(d.cc) : existing.cc_json,
    d.bcc ? JSON.stringify(d.bcc) : existing.bcc_json,
    d.subject ?? existing.subject,
    nextHtml,
    nextText,
    d.isPlainText !== undefined ? (d.isPlainText ? 1 : 0) : existing.is_plain_text,
    now,
    id,
    userId
  );

  const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Record<string, any>;
  res.json({ draft: formatDraftRow(db, updated) });
});

const uploadAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(20_000_000),
  isInline: z.boolean().optional().default(false),
  contentId: z.string().optional(),
});

draftsRouter.post('/:id/attachments', requireAuth, (req, res) => {
  const draftId = param(req, 'id');
  const parsed = uploadAttachmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid attachment upload payload' });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const draft = db.prepare('SELECT id FROM drafts WHERE id = ? AND user_id = ?').get(draftId, userId);
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const { filename, mimeType, contentBase64, isInline, contentId } = parsed.data;
  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.byteLength > 15 * 1024 * 1024) {
    res.status(413).json({ error: 'Attachment exceeds 15 MB limit' });
    return;
  }

  const stored = storeAttachmentBuffer(userId, filename, mimeType, buf, {
    draftId,
    contentId,
    isInline,
  });

  db.prepare(
    `INSERT INTO attachments (id, message_id, draft_id, user_id, filename, mime_type, size_bytes, content_id, is_inline, storage_path, sha256, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    stored.id,
    draftId,
    userId,
    filename,
    mimeType,
    stored.sizeBytes,
    contentId || '',
    isInline ? 1 : 0,
    stored.storagePath,
    stored.sha256,
    new Date().toISOString()
  );

  res.status(201).json({
    attachment: {
      id: stored.id,
      filename,
      mimeType,
      sizeBytes: stored.sizeBytes,
      contentId: contentId || '',
      isInline,
    },
  });
});

draftsRouter.delete('/:id/attachments/:attId', requireAuth, (req, res) => {
  const db = getDb();
  const attId = param(req, 'attId');
  const draftId = param(req, 'id');
  const att = db
    .prepare('SELECT storage_path FROM attachments WHERE id = ? AND draft_id = ? AND user_id = ?')
    .get(attId, draftId, req.auth!.id) as { storage_path: string } | undefined;

  if (!att) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  try {
    if (fs.existsSync(att.storage_path)) fs.unlinkSync(att.storage_path);
  } catch {
    // ignore
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(attId);
  res.json({ ok: true });
});

draftsRouter.post('/:id/send', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const draftId = param(req, 'id');
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(draftId, userId) as
    | Record<string, any>
    | undefined;
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const to = JSON.parse(draft.to_json || '[]');
  const cc = JSON.parse(draft.cc_json || '[]');
  const bcc = JSON.parse(draft.bcc_json || '[]');
  if (to.length + cc.length + bcc.length === 0) {
    res.status(400).json({ error: 'Add at least one recipient before sending' });
    return;
  }

  const delaySeconds = Math.max(0, Math.min(30, Number(req.body?.undoDelaySeconds ?? 0)));
  const now = new Date();

  if (delaySeconds > 0) {
    const undoUntil = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    db.prepare(
      "UPDATE drafts SET status = 'queued_undo', undo_send_until = ?, scheduled_for = NULL, last_error = NULL, updated_at = ? WHERE id = ?"
    ).run(undoUntil, now.toISOString(), draft.id);
    const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft.id) as Record<string, any>;
    res.json({ status: 'queued_undo', undoSendUntil: undoUntil, draft: formatDraftRow(db, updated) });
    return;
  }

  db.prepare("UPDATE drafts SET status = 'sending', last_error = NULL, updated_at = ? WHERE id = ?").run(
    now.toISOString(),
    draft.id
  );
  const result = await dispatchDraftNow(db, draft.id);
  if (!result.ok) {
    res.status(502).json({ status: 'failed', error: result.error });
    return;
  }
  res.json({ status: 'sent', messageId: result.messageId, threadId: result.threadId });
});

draftsRouter.post('/:id/cancel-undo', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const draftId = param(req, 'id');
  const now = new Date().toISOString();
  const resUpd = db
    .prepare("UPDATE drafts SET status = 'draft', undo_send_until = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'queued_undo'")
    .run(now, draftId, userId);

  if (resUpd.changes === 0) {
    res.status(409).json({ error: 'Message was already dispatched or not queued for undo' });
    return;
  }
  const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId) as Record<string, any>;
  res.json({ ok: true, draft: formatDraftRow(db, updated) });
});

const scheduleSchema = z.object({
  scheduledFor: z.string().min(1),
  timezone: z.string().min(1).default('UTC'),
});

draftsRouter.post('/:id/schedule', requireAuth, (req, res) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid scheduled date/time is required' });
    return;
  }
  const targetTime = new Date(parsed.data.scheduledFor);
  if (Number.isNaN(targetTime.getTime()) || targetTime.getTime() <= Date.now()) {
    res.status(400).json({ error: 'Scheduled time must be in the future' });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(param(req, 'id'), userId) as
    | Record<string, any>
    | undefined;
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const to = JSON.parse(draft.to_json || '[]');
  const cc = JSON.parse(draft.cc_json || '[]');
  const bcc = JSON.parse(draft.bcc_json || '[]');
  if (to.length + cc.length + bcc.length === 0) {
    res.status(400).json({ error: 'Add at least one recipient before scheduling' });
    return;
  }

  db.prepare(
    "UPDATE drafts SET status = 'scheduled', scheduled_for = ?, scheduled_timezone = ?, undo_send_until = NULL, updated_at = ? WHERE id = ?"
  ).run(targetTime.toISOString(), parsed.data.timezone, new Date().toISOString(), draft.id);

  const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft.id) as Record<string, any>;
  res.json({ status: 'scheduled', draft: formatDraftRow(db, updated) });
});

draftsRouter.post('/:id/cancel-schedule', requireAuth, (req, res) => {
  const db = getDb();
  const draftId = param(req, 'id');
  const resUpd = db
    .prepare("UPDATE drafts SET status = 'draft', scheduled_for = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'scheduled'")
    .run(new Date().toISOString(), draftId, req.auth!.id);

  if (resUpd.changes === 0) {
    res.status(409).json({ error: 'Draft is not currently scheduled' });
    return;
  }
  const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId) as Record<string, any>;
  res.json({ ok: true, draft: formatDraftRow(db, updated) });
});

draftsRouter.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const draftId = param(req, 'id');
  const atts = db
    .prepare('SELECT storage_path FROM attachments WHERE draft_id = ? AND user_id = ?')
    .all(draftId, req.auth!.id) as Array<{ storage_path: string }>;
  for (const a of atts) {
    try {
      if (fs.existsSync(a.storage_path)) fs.unlinkSync(a.storage_path);
    } catch {
      // ignore
    }
  }
  db.prepare('DELETE FROM attachments WHERE draft_id = ? AND user_id = ?').run(draftId, req.auth!.id);
  db.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').run(draftId, req.auth!.id);
  res.json({ ok: true });
});
