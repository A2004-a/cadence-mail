import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { ProviderCredentials } from '../providers/types.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import { decryptSecret } from '../security/crypto.js';
import { eventBus } from '../services/eventBus.js';
import { emptySystemFolder, purgeExpiredRetentionMessages } from '../services/sendService.js';
import { getOrCreateFolderByRole, recomputeThreadState } from '../services/threadService.js';
import type { ProviderType } from '../types.js';

export const threadsRouter = Router();

export function hydrateThreadList(db: ReturnType<typeof getDb>, userId: string, threadIds: string[]) {
  if (threadIds.length === 0) return [];
  const placeholders = threadIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.*, a.email_address AS account_email, a.display_name AS account_name, a.avatar_color AS account_color, a.provider_type
       FROM threads t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.id IN (${placeholders})`
    )
    .all(userId, ...threadIds) as Array<Record<string, any>>;

  const labelStmt = db.prepare(
    `SELECT DISTINCT l.id, l.name, l.color
     FROM message_labels ml
     JOIN labels l ON l.id = ml.label_id
     JOIN messages m ON m.id = ml.message_id
     WHERE m.thread_id = ?`
  );

  const byId = new Map<string, any>();
  for (const r of rows) {
    const labels = labelStmt.all(r.id) as Array<{ id: string; name: string; color: string }>;
    byId.set(r.id, {
      id: r.id,
      accountId: r.account_id,
      accountEmail: r.account_email,
      accountName: r.account_name,
      accountColor: r.account_color,
      providerType: r.provider_type,
      subject: r.subject,
      snippet: r.snippet,
      lastMessageAt: r.last_message_at,
      messageCount: r.message_count,
      unreadCount: r.unread_count,
      isStarred: Boolean(r.is_starred),
      isImportant: Boolean(r.is_important),
      isPinned: Boolean(r.is_pinned),
      inInbox: Boolean(r.in_inbox),
      inSent: Boolean(r.in_sent),
      inArchive: Boolean(r.in_archive),
      inSpam: Boolean(r.in_spam),
      inTrash: Boolean(r.in_trash),
      hasAttachments: Boolean(r.has_attachments),
      categorySlug: r.category_slug,
      priorityScore: r.priority_score,
      participants: JSON.parse(r.participants_json || '[]'),
      snoozedUntil: r.snoozed_until,
      labels,
    });
  }

  return threadIds.map((id) => byId.get(id)).filter(Boolean);
}

export function getViewCounts(db: ReturnType<typeof getDb>, userId: string, accountId?: string) {
  const acctFilter = accountId ? 'AND account_id = ?' : '';
  const acctParams = accountId ? [userId, accountId] : [userId];

  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN in_inbox = 1 AND unread_count > 0 THEN 1 ELSE 0 END) AS inbox_unread,
         SUM(CASE WHEN in_inbox = 1 THEN 1 ELSE 0 END) AS inbox_total,
         SUM(CASE WHEN in_inbox = 1 AND priority_score >= 0.65 AND unread_count > 0 THEN 1 ELSE 0 END) AS priority_unread,
         SUM(CASE WHEN is_starred = 1 AND in_trash = 0 AND in_spam = 0 THEN 1 ELSE 0 END) AS starred_total,
         SUM(CASE WHEN is_important = 1 AND in_trash = 0 AND in_spam = 0 THEN 1 ELSE 0 END) AS important_total,
         SUM(CASE WHEN snoozed_until IS NOT NULL THEN 1 ELSE 0 END) AS snoozed_total,
         SUM(CASE WHEN in_spam = 1 THEN 1 ELSE 0 END) AS spam_total,
         SUM(CASE WHEN in_trash = 1 THEN 1 ELSE 0 END) AS trash_total
       FROM threads
       WHERE user_id = ? ${acctFilter}`
    )
    .get(...acctParams) as Record<string, number | null>;

  const draftsCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM drafts WHERE user_id = ? ${acctFilter} AND status IN ('draft', 'scheduled', 'queued_undo', 'failed')`)
    .get(...acctParams) as { cnt: number };

  const catRows = db
    .prepare(
      `SELECT category_slug, COUNT(*) AS total, SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END) AS unread
       FROM threads
       WHERE user_id = ? ${acctFilter} AND in_inbox = 1
       GROUP BY category_slug`
    )
    .all(...acctParams) as Array<{ category_slug: string; total: number; unread: number }>;

  const categories: Record<string, { total: number; unread: number }> = {};
  for (const c of catRows) {
    categories[c.category_slug] = { total: c.total, unread: c.unread || 0 };
  }

  return {
    inboxUnread: row.inbox_unread || 0,
    inboxTotal: row.inbox_total || 0,
    priorityUnread: row.priority_unread || 0,
    starred: row.starred_total || 0,
    important: row.important_total || 0,
    snoozed: row.snoozed_total || 0,
    spam: row.spam_total || 0,
    trash: row.trash_total || 0,
    drafts: draftsCount.cnt || 0,
    categories,
  };
}

threadsRouter.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const view = String(req.query.view || 'inbox');
  const accountId = req.query.accountId ? String(req.query.accountId) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;
  const folderId = req.query.folderId ? String(req.query.folderId) : undefined;
  const labelId = req.query.labelId ? String(req.query.labelId) : undefined;
  const unreadOnly = req.query.unreadOnly === 'true';
  const hasAttachment = req.query.hasAttachment === 'true';
  const sortBy = String(req.query.sortBy || 'date_desc');
  const limit = Math.min(Number(req.query.limit || 60), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const where: string[] = ['t.user_id = ?', 't.message_count > 0'];
  const params: Array<string | number> = [userId];

  if (accountId) {
    where.push('t.account_id = ?');
    params.push(accountId);
  }

  if (unreadOnly) where.push('t.unread_count > 0');
  if (hasAttachment) where.push('t.has_attachments = 1');

  switch (view) {
    case 'inbox':
      where.push('t.in_inbox = 1');
      if (category && category !== 'all') {
        where.push('t.category_slug = ?');
        params.push(category);
      }
      break;
    case 'priority':
      where.push('t.in_inbox = 1 AND t.priority_score >= 0.65');
      break;
    case 'unread':
      where.push('t.in_trash = 0 AND t.in_spam = 0 AND t.unread_count > 0');
      break;
    case 'starred':
      where.push('t.is_starred = 1 AND t.in_trash = 0 AND t.in_spam = 0');
      break;
    case 'important':
      where.push('t.is_important = 1 AND t.in_trash = 0 AND t.in_spam = 0');
      break;
    case 'sent':
      where.push('t.in_sent = 1 AND t.in_trash = 0 AND t.in_spam = 0');
      break;
    case 'snoozed':
      where.push('t.snoozed_until IS NOT NULL');
      break;
    case 'archive':
      where.push('t.in_archive = 1');
      break;
    case 'spam':
      where.push('t.in_spam = 1');
      break;
    case 'trash':
      where.push('t.in_trash = 1');
      break;
    case 'all':
      where.push('t.in_trash = 0 AND t.in_spam = 0');
      break;
    case 'folder':
      if (folderId) {
        where.push('EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder_id = ? AND m.is_draft = 0)');
        params.push(folderId);
      }
      break;
    case 'label':
      if (labelId) {
        where.push(
          'EXISTS (SELECT 1 FROM messages m JOIN message_labels ml ON ml.message_id = m.id WHERE m.thread_id = t.id AND ml.label_id = ?)'
        );
        params.push(labelId);
      }
      break;
  }

  let orderBy = 't.is_pinned DESC, t.last_message_at DESC';
  if (sortBy === 'date_asc') orderBy = 't.is_pinned DESC, t.last_message_at ASC';
  else if (sortBy === 'priority') orderBy = 't.is_pinned DESC, t.priority_score DESC, t.last_message_at DESC';
  else if (sortBy === 'sender') orderBy = 't.is_pinned DESC, t.participants_json ASC, t.last_message_at DESC';

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM threads t WHERE ${where.join(' AND ')}`)
    .get(...params) as { total: number };

  const idRows = db
    .prepare(`SELECT t.id FROM threads t WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<{ id: string }>;

  const threads = hydrateThreadList(
    db,
    userId,
    idRows.map((r) => r.id)
  );
  const counts = getViewCounts(db, userId, accountId);

  res.json({ threads, total: countRow.total, counts });
});

threadsRouter.get('/attachments/:attachmentId', requireAuth, (req, res) => {
  const db = getDb();
  const att = db
    .prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?')
    .get(param(req, 'attachmentId'), req.auth!.id) as
    | {
        id: string;
        filename: string;
        mime_type: string;
        storage_path: string;
      }
    | undefined;

  if (!att || !fs.existsSync(att.storage_path)) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }

  const inlineAllowed = req.query.inline === '1' && /^image\/(png|jpeg|jpg|gif|webp)$/i.test(att.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', inlineAllowed ? att.mime_type : 'application/octet-stream');
  const safeName = att.filename.replace(/["\r\n]/g, '_');
  res.setHeader('Content-Disposition', `${inlineAllowed ? 'inline' : 'attachment'}; filename="${safeName}"`);
  fs.createReadStream(att.storage_path).pipe(res);
});

function parseListUnsubscribe(rawHeadersJson: string | null | undefined): { httpUrl?: string; mailto?: string } | null {
  if (!rawHeadersJson) return null;
  try {
    const headers = JSON.parse(rawHeadersJson) as Record<string, string | string[]>;
    const rawEntry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'list-unsubscribe')?.[1];
    if (!rawEntry) return null;
    const rawStr = Array.isArray(rawEntry) ? rawEntry.join(', ') : String(rawEntry);
    const httpMatch = rawStr.match(/https?:\/\/[^\s<>",;]+/i);
    const mailtoMatch = rawStr.match(/mailto:([^\s<>",;?]+)/i);
    if (!httpMatch && !mailtoMatch) return null;
    return {
      ...(httpMatch ? { httpUrl: httpMatch[0] } : {}),
      ...(mailtoMatch ? { mailto: mailtoMatch[1] } : {}),
    };
  } catch {
    return null;
  }
}

threadsRouter.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const thread = db
    .prepare(
      `SELECT t.*, a.email_address AS account_email, a.display_name AS account_name, a.avatar_color AS account_color, a.provider_type
       FROM threads t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.id = ? AND t.user_id = ?`
    )
    .get(param(req, 'id'), userId) as Record<string, any> | undefined;

  if (!thread) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const msgs = db
    .prepare(
      `SELECT m.*, f.name AS folder_name, f.system_role AS folder_role
       FROM messages m
       LEFT JOIN folders f ON f.id = m.folder_id
       WHERE m.thread_id = ? AND m.user_id = ? AND m.is_draft = 0
       ORDER BY m.received_at ASC`
    )
    .all(thread.id, userId) as Array<Record<string, any>>;

  const attStmt = db.prepare(
    'SELECT id, filename, mime_type, size_bytes, content_id, is_inline FROM attachments WHERE message_id = ?'
  );
  const labelStmt = db.prepare(
    'SELECT l.id, l.name, l.color FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ?'
  );

  const formattedMessages = msgs.map((m) => ({
    id: m.id,
    threadId: m.thread_id,
    accountId: m.account_id,
    messageIdHeader: m.message_id_header,
    inReplyTo: m.in_reply_to,
    folderId: m.folder_id,
    folderName: m.folder_name,
    folderRole: m.folder_role,
    fromName: m.from_name,
    fromAddress: m.from_address,
    to: JSON.parse(m.to_json || '[]'),
    cc: JSON.parse(m.cc_json || '[]'),
    bcc: JSON.parse(m.bcc_json || '[]'),
    replyTo: JSON.parse(m.reply_to_json || '[]'),
    subject: m.subject,
    bodyHtmlSanitized: m.body_html_sanitized,
    bodyText: m.body_text,
    snippet: m.snippet,
    hasExternalImages: Boolean(m.has_external_images),
    suspiciousLinks: JSON.parse(m.suspicious_links_json || '[]'),
    authResults: JSON.parse(m.auth_results_json || '{}'),
    listUnsubscribe: parseListUnsubscribe(m.raw_headers_json),
    sentAt: m.sent_at,
    receivedAt: m.received_at,
    isRead: Boolean(m.is_read),
    isStarred: Boolean(m.is_starred),
    isImportant: Boolean(m.is_important),
    isSpam: Boolean(m.is_spam),
    isTrash: Boolean(m.is_trash),
    isArchived: Boolean(m.is_archived),
    hasAttachments: Boolean(m.has_attachments),
    categorySlug: m.category_slug,
    sizeBytes: m.size_bytes,
    deliveryStatus: m.delivery_status || 'synced',
    deliveryDetail: m.delivery_detail || '',
    attachments: (attStmt.all(m.id) as Array<Record<string, any>>).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      contentId: a.content_id,
      isInline: Boolean(a.is_inline),
    })),
    labels: labelStmt.all(m.id),
  }));

  const threadLabels = db
    .prepare(
      `SELECT DISTINCT l.id, l.name, l.color
       FROM message_labels ml
       JOIN labels l ON l.id = ml.label_id
       JOIN messages m ON m.id = ml.message_id
       WHERE m.thread_id = ?`
    )
    .all(thread.id) as Array<{ id: string; name: string; color: string }>;

  res.json({
    thread: {
      id: thread.id,
      accountId: thread.account_id,
      accountEmail: thread.account_email,
      accountName: thread.account_name,
      accountColor: thread.account_color,
      providerType: thread.provider_type,
      subject: thread.subject,
      snippet: thread.snippet,
      lastMessageAt: thread.last_message_at,
      messageCount: thread.message_count,
      unreadCount: thread.unread_count,
      isStarred: Boolean(thread.is_starred),
      isImportant: Boolean(thread.is_important),
      isPinned: Boolean(thread.is_pinned),
      categorySlug: thread.category_slug,
      priorityScore: thread.priority_score,
      participants: JSON.parse(thread.participants_json || '[]'),
      snoozedUntil: thread.snoozed_until,
      labels: threadLabels,
    },
    messages: formattedMessages,
  });
});

const bulkSchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum([
    'mark_read',
    'mark_unread',
    'star',
    'unstar',
    'important',
    'unimportant',
    'archive',
    'delete',
    'restore',
    'permanent_delete',
    'spam',
    'not_spam',
    'snooze',
    'unsnooze',
    'move_folder',
    'add_label',
    'remove_label',
    'pin',
    'unpin',
    'categorize',
  ]),
  snoozedUntil: z.string().optional(),
  folderId: z.string().optional(),
  labelId: z.string().optional(),
  categorySlug: z.string().optional(),
});

threadsRouter.post('/bulk', requireAuth, async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid bulk action request', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const { threadIds, action, snoozedUntil, folderId, labelId, categorySlug } = parsed.data;
  const now = new Date().toISOString();

  const updatedThreadIds: string[] = [];

  for (const tid of threadIds) {
    const tRow = db.prepare('SELECT id, account_id FROM threads WHERE id = ? AND user_id = ?').get(tid, userId) as
      | { id: string; account_id: string }
      | undefined;
    if (!tRow) continue;

    switch (action) {
      case 'mark_read':
        db.prepare('UPDATE messages SET is_read = 1 WHERE thread_id = ? AND user_id = ?').run(tid, userId);
        break;
      case 'mark_unread':
        db.prepare(
          `UPDATE messages SET is_read = 0
           WHERE id = (SELECT id FROM messages WHERE thread_id = ? AND user_id = ? AND is_draft = 0 ORDER BY received_at DESC LIMIT 1)`
        ).run(tid, userId);
        break;
      case 'star':
        db.prepare(
          `UPDATE messages SET is_starred = 1
           WHERE id = (SELECT id FROM messages WHERE thread_id = ? AND user_id = ? AND is_draft = 0 ORDER BY received_at DESC LIMIT 1)`
        ).run(tid, userId);
        break;
      case 'unstar':
        db.prepare('UPDATE messages SET is_starred = 0 WHERE thread_id = ? AND user_id = ?').run(tid, userId);
        break;
      case 'important':
        db.prepare('UPDATE messages SET is_important = 1 WHERE thread_id = ? AND user_id = ?').run(tid, userId);
        break;
      case 'unimportant':
        db.prepare('UPDATE messages SET is_important = 0 WHERE thread_id = ? AND user_id = ?').run(tid, userId);
        break;
      case 'pin':
        db.prepare('UPDATE threads SET is_pinned = 1, updated_at = ? WHERE id = ? AND user_id = ?').run(now, tid, userId);
        break;
      case 'unpin':
        db.prepare('UPDATE threads SET is_pinned = 0, updated_at = ? WHERE id = ? AND user_id = ?').run(now, tid, userId);
        break;
      case 'archive': {
        const archiveId = getOrCreateFolderByRole(db, userId, tRow.account_id, 'archive');
        db.prepare('UPDATE messages SET is_archived = 1, is_trash = 0, is_spam = 0, folder_id = ? WHERE thread_id = ? AND user_id = ?').run(
          archiveId,
          tid,
          userId
        );
        db.prepare('UPDATE threads SET snoozed_until = NULL WHERE id = ?').run(tid);
        break;
      }
      case 'delete': {
        const trashId = getOrCreateFolderByRole(db, userId, tRow.account_id, 'trash');
        db.prepare('UPDATE messages SET is_trash = 1, folder_id = ? WHERE thread_id = ? AND user_id = ?').run(trashId, tid, userId);
        db.prepare('UPDATE threads SET snoozed_until = NULL WHERE id = ?').run(tid);
        break;
      }
      case 'restore':
      case 'not_spam': {
        const inboxId = getOrCreateFolderByRole(db, userId, tRow.account_id, 'inbox');
        db.prepare('UPDATE messages SET is_trash = 0, is_spam = 0, is_archived = 0, folder_id = ? WHERE thread_id = ? AND user_id = ?').run(
          inboxId,
          tid,
          userId
        );
        break;
      }
      case 'permanent_delete': {
        const atts = db
          .prepare('SELECT a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ? AND m.user_id = ?')
          .all(tid, userId) as Array<{ storage_path: string }>;
        for (const a of atts) {
          try {
            if (fs.existsSync(a.storage_path)) fs.unlinkSync(a.storage_path);
          } catch {
            // ignore
          }
        }
        db.prepare('DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(tid);
        db.prepare('DELETE FROM threads WHERE id = ? AND user_id = ?').run(tid, userId);
        updatedThreadIds.push(tid);
        continue;
      }
      case 'spam': {
        const spamId = getOrCreateFolderByRole(db, userId, tRow.account_id, 'spam');
        db.prepare('UPDATE messages SET is_spam = 1, is_trash = 0, folder_id = ? WHERE thread_id = ? AND user_id = ?').run(
          spamId,
          tid,
          userId
        );
        break;
      }
      case 'snooze': {
        const wakeAt = snoozedUntil || new Date(Date.now() + 3600_000 * 4).toISOString();
        db.prepare('UPDATE threads SET snoozed_until = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
          wakeAt,
          now,
          tid,
          userId
        );
        break;
      }
      case 'unsnooze':
        db.prepare('UPDATE threads SET snoozed_until = NULL, updated_at = ? WHERE id = ? AND user_id = ?').run(now, tid, userId);
        break;
      case 'move_folder':
        if (folderId) {
          const folder = db
            .prepare('SELECT id, system_role FROM folders WHERE id = ? AND user_id = ? AND account_id = ?')
            .get(folderId, userId, tRow.account_id) as { id: string; system_role: string } | undefined;
          if (folder) {
            db.prepare('UPDATE messages SET folder_id = ?, is_trash = ?, is_spam = ?, is_archived = ? WHERE thread_id = ? AND user_id = ?').run(
              folder.id,
              folder.system_role === 'trash' ? 1 : 0,
              folder.system_role === 'spam' ? 1 : 0,
              folder.system_role === 'archive' ? 1 : 0,
              tid,
              userId
            );
          }
        }
        break;
      case 'add_label':
        if (labelId) {
          const msgs = db.prepare('SELECT id FROM messages WHERE thread_id = ? AND user_id = ?').all(tid, userId) as Array<{ id: string }>;
          for (const m of msgs) {
            db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)').run(m.id, labelId);
          }
        }
        break;
      case 'remove_label':
        if (labelId) {
          db.prepare('DELETE FROM message_labels WHERE label_id = ? AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(
            labelId,
            tid
          );
        }
        break;
      case 'categorize':
        if (categorySlug) {
          db.prepare('UPDATE messages SET category_slug = ? WHERE thread_id = ? AND user_id = ?').run(categorySlug, tid, userId);
          db.prepare('UPDATE threads SET category_slug = ? WHERE id = ? AND user_id = ?').run(categorySlug, tid, userId);
        }
        break;
    }

    recomputeThreadState(db, tid);
    updatedThreadIds.push(tid);
  }

  // Best-effort remote sync back for flags, moves, and labels
  const remoteSyncableActions = [
    'mark_read',
    'mark_unread',
    'star',
    'unstar',
    'archive',
    'delete',
    'spam',
    'restore',
    'move_folder',
    'add_label',
    'remove_label',
  ];
  if (remoteSyncableActions.includes(action)) {
    try {
      const placeholders = threadIds.map(() => '?').join(',');
      const remoteRows = db
        .prepare(
          `SELECT m.remote_id, a.id AS account_id, a.provider_type, a.encrypted_credentials
           FROM messages m
           JOIN accounts a ON a.id = m.account_id
           WHERE m.user_id = ? AND m.thread_id IN (${placeholders}) AND m.remote_id IS NOT NULL AND a.provider_type != 'local'`
        )
        .all(userId, ...threadIds) as Array<{
        remote_id: string;
        account_id: string;
        provider_type: ProviderType;
        encrypted_credentials: string;
      }>;

      const byAccount = new Map<string, { provider: ProviderType; creds: string; ids: string[] }>();
      for (const r of remoteRows) {
        let entry = byAccount.get(r.account_id);
        if (!entry) {
          entry = { provider: r.provider_type, creds: r.encrypted_credentials, ids: [] };
          byAccount.set(r.account_id, entry);
        }
        entry.ids.push(r.remote_id);
      }

      const targetFolderRow =
        action === 'move_folder' && folderId
          ? (db.prepare('SELECT remote_id, system_role FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId) as
              | { remote_id: string | null; system_role: string }
              | undefined)
          : undefined;
      const targetLabelRow =
        (action === 'add_label' || action === 'remove_label') && labelId
          ? (db.prepare('SELECT remote_id, name FROM labels WHERE id = ? AND user_id = ?').get(labelId, userId) as
              | { remote_id: string | null; name: string }
              | undefined)
          : undefined;

      for (const [, entry] of byAccount) {
        const adapter = getProviderAdapter(entry.provider);
        const creds = JSON.parse(decryptSecret(entry.creds)) as ProviderCredentials;
        if ((action === 'mark_read' || action === 'mark_unread') && adapter.markRead) {
          await adapter.markRead(creds, entry.ids, action === 'mark_read');
        } else if ((action === 'star' || action === 'unstar') && adapter.setStarred) {
          await adapter.setStarred(creds, entry.ids, action === 'star');
        } else if (adapter.moveToFolder) {
          if (action === 'archive') await adapter.moveToFolder(creds, entry.ids, 'archive');
          else if (action === 'delete') await adapter.moveToFolder(creds, entry.ids, 'trash');
          else if (action === 'spam') await adapter.moveToFolder(creds, entry.ids, 'spam');
          else if (action === 'restore') await adapter.moveToFolder(creds, entry.ids, 'inbox');
          else if (action === 'move_folder' && targetFolderRow) {
            await adapter.moveToFolder(creds, entry.ids, targetFolderRow.remote_id || targetFolderRow.system_role);
          }
        }
        if (action === 'add_label' && adapter.applyLabel && targetLabelRow?.remote_id) {
          await adapter.applyLabel(creds, entry.ids, targetLabelRow.remote_id);
        } else if (action === 'remove_label' && adapter.removeLabel && targetLabelRow?.remote_id) {
          await adapter.removeLabel(creds, entry.ids, targetLabelRow.remote_id);
        }
      }
    } catch {
      // remote push is best-effort; local DB change persists
    }
  }

  eventBus.emit(userId, 'thread_updated', { threadIds: updatedThreadIds, action });
  res.json({ ok: true, updatedCount: updatedThreadIds.length });
});

threadsRouter.post('/:id/report-phishing', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const tid = param(req, 'id');
  const thread = db.prepare('SELECT id, account_id FROM threads WHERE id = ? AND user_id = ?').get(tid, userId) as
    | { id: string; account_id: string }
    | undefined;
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  const msgs = db.prepare('SELECT from_address FROM messages WHERE thread_id = ?').all(tid) as Array<{
    from_address: string;
  }>;
  const spamId = getOrCreateFolderByRole(db, userId, thread.account_id, 'spam');
  db.prepare('UPDATE messages SET is_spam = 1, folder_id = ? WHERE thread_id = ? AND user_id = ?').run(spamId, tid, userId);

  if (req.body?.blockSender && msgs.length > 0) {
    const sender = msgs[msgs.length - 1].from_address.toLowerCase();
    db.prepare('INSERT OR IGNORE INTO blocked_senders (id, user_id, email_or_domain, created_at) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(),
      userId,
      sender,
      new Date().toISOString()
    );
  }
  recomputeThreadState(db, tid);
  res.json({ ok: true });
});

threadsRouter.post('/block-sender', requireAuth, (req, res) => {
  const emailOrDomain = String(req.body?.emailOrDomain || '').trim().toLowerCase();
  if (!emailOrDomain) {
    res.status(400).json({ error: 'Email address or domain is required' });
    return;
  }
  const db = getDb();
  const userId = req.auth!.id;
  db.prepare('INSERT OR IGNORE INTO blocked_senders (id, user_id, email_or_domain, created_at) VALUES (?, ?, ?, ?)').run(
    crypto.randomUUID(),
    userId,
    emailOrDomain,
    new Date().toISOString()
  );
  const matchedThreads = db
    .prepare(
      'SELECT DISTINCT thread_id, account_id FROM messages WHERE user_id = ? AND (lower(from_address) = ? OR lower(from_address) LIKE ?)'
    )
    .all(userId, emailOrDomain, `%@${emailOrDomain}`) as Array<{ thread_id: string; account_id: string }>;

  for (const row of matchedThreads) {
    const spamId = getOrCreateFolderByRole(db, userId, row.account_id, 'spam');
    db.prepare('UPDATE messages SET is_spam = 1, folder_id = ? WHERE thread_id = ? AND user_id = ?').run(
      spamId,
      row.thread_id,
      userId
    );
    recomputeThreadState(db, row.thread_id);
  }
  res.json({ ok: true, blocked: emailOrDomain });
});

threadsRouter.post('/retention/purge', requireAuth, (req, res) => {
  const db = getDb();
  const result = purgeExpiredRetentionMessages(db, req.auth!.id);
  res.json({ ok: true, ...result });
});

threadsRouter.post('/folder/empty', requireAuth, (req, res) => {
  const folder = req.body?.folder === 'spam' ? 'spam' : req.body?.folder === 'trash' ? 'trash' : null;
  if (!folder) {
    res.status(400).json({ error: 'Valid folder ("trash" or "spam") is required' });
    return;
  }
  const accountId = typeof req.body?.accountId === 'string' && req.body.accountId ? req.body.accountId : undefined;
  const db = getDb();
  const result = emptySystemFolder(db, req.auth!.id, folder, accountId);
  res.json({ ok: true, ...result });
});
