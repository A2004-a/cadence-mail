import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ATTACHMENTS_DIR } from '../config.js';
import type { RemoteMessagePayload } from '../providers/types.js';
import { sha256Hex } from '../security/crypto.js';
import { sanitizeEmailContent } from '../security/sanitize.js';
import type { EmailParticipant, SystemFolderRole } from '../types.js';
import { eventBus } from './eventBus.js';
import { createUserNotification } from './notificationService.js';
import { applyRuleActionsToMessage, doesRuleMatch, loadUserRules } from './ruleEngine.js';

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(?:(?:re|fwd|fw)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

export function inferCategory(subject: string, bodyText: string, fromAddress: string): string {
  const hay = `${subject} ${bodyText} ${fromAddress}`.toLowerCase();
  if (/(unsubscribe|newsletter|digest|weekly issue|edition #)/i.test(hay)) return 'newsletters';
  if (/(% off|promo|discount|sale ends|coupon|deal|offer)/i.test(hay)) return 'promotions';
  if (/(flight|boarding pass|itinerary|hotel reservation|check-in|booking confirmation|pnr)/i.test(hay)) return 'travel';
  if (/(invoice|statement|tax|payment due|wire transfer|bank|payout|payroll|billing)/i.test(hay)) return 'financial';
  if (/(shipped|tracking number|delivery window|order #|package|cart|refund)/i.test(hay)) return 'shopping';
  if (/(security alert|verification code|otp|password reset|automated alert|do-not-reply|noreply)/i.test(hay)) {
    return 'notifications';
  }
  if (/(release notes|status update|incident|changelog|maintenance)/i.test(hay)) return 'updates';
  if (/(linkedin|github|slack|twitter|x\.com|figma|notion|commented|mentioned you)/i.test(hay)) return 'social';
  if (/(sprint|roadmap|q[1-4]|okr|deployment|contract|nda|review|meeting|budget|design spec)/i.test(hay)) {
    return 'work';
  }
  return 'primary';
}

export function computePriorityScore(
  fromAddress: string,
  subject: string,
  bodyText: string,
  isImportant: boolean,
  isStarred: boolean,
  category: string,
  isKnownContact: boolean
): number {
  let score = 0.4;
  if (isImportant) score += 0.3;
  if (isStarred) score += 0.2;
  if (isKnownContact) score += 0.15;
  if (category === 'primary' || category === 'work') score += 0.1;
  if (category === 'promotions' || category === 'newsletters') score -= 0.25;
  if (/(urgent|asap|deadline|action required|decision|blocker|invoice due)/i.test(`${subject} ${bodyText}`)) {
    score += 0.2;
  }
  if (/no-?reply|noreply|notifications@/i.test(fromAddress)) score -= 0.15;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function storeAttachmentBuffer(
  userId: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  opts: { messageId?: string; draftId?: string; contentId?: string; isInline?: boolean }
): { id: string; storagePath: string; sizeBytes: number; sha256: string } {
  const id = crypto.randomUUID();
  const safeBase = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
  const userDir = path.join(ATTACHMENTS_DIR, userId);
  fs.mkdirSync(userDir, { recursive: true });
  const storagePath = path.join(userDir, `${id}_${safeBase}`);
  fs.writeFileSync(storagePath, content);
  const sha = sha256Hex(content);
  return { id, storagePath, sizeBytes: content.byteLength, sha256: sha };
}

export function getOrCreateFolderByRole(
  db: DatabaseSync,
  userId: string,
  accountId: string,
  role: SystemFolderRole,
  fallbackName?: string
): string {
  const existing = db
    .prepare('SELECT id FROM folders WHERE account_id = ? AND system_role = ? LIMIT 1')
    .get(accountId, role) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const label = fallbackName || role.charAt(0).toUpperCase() + role.slice(1);
  db.prepare(
    `INSERT INTO folders (id, account_id, user_id, remote_id, name, slug, system_role, color, sort_order, is_favorite, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '#64748B', 0, 0, ?)`
  ).run(id, accountId, userId, role, label, role, role, new Date().toISOString());
  return id;
}

export function recomputeThreadState(db: DatabaseSync, threadId: string): void {
  const threadRow = db
    .prepare('SELECT id, snoozed_until FROM threads WHERE id = ?')
    .get(threadId) as { id: string; snoozed_until: string | null } | undefined;
  if (!threadRow) return;

  const msgs = db
    .prepare(
      `SELECT m.*, f.system_role AS folder_role
       FROM messages m
       LEFT JOIN folders f ON f.id = m.folder_id
       WHERE m.thread_id = ? AND m.is_draft = 0
       ORDER BY m.received_at ASC`
    )
    .all(threadId) as Array<{
    id: string;
    from_name: string;
    from_address: string;
    to_json: string;
    cc_json: string;
    subject: string;
    snippet: string;
    received_at: string;
    is_read: number;
    is_starred: number;
    is_important: number;
    is_spam: number;
    is_trash: number;
    is_archived: number;
    has_attachments: number;
    category_slug: string;
    folder_role: string | null;
  }>;

  if (msgs.length === 0) return;

  const activeMsgs = msgs.filter((m) => !m.is_trash && !m.is_spam);
  const pool = activeMsgs.length > 0 ? activeMsgs : msgs;
  const latest = pool[pool.length - 1];

  const unreadCount = activeMsgs.reduce((acc, m) => acc + (m.is_read ? 0 : 1), 0);
  const isStarred = activeMsgs.some((m) => m.is_starred === 1) ? 1 : 0;
  const isImportant = activeMsgs.some((m) => m.is_important === 1) ? 1 : 0;
  const hasAttachments = activeMsgs.some((m) => m.has_attachments === 1) ? 1 : 0;

  const isSnoozed = Boolean(threadRow.snoozed_until && new Date(threadRow.snoozed_until).getTime() > Date.now());
  const inTrash = msgs.every((m) => m.is_trash === 1) || (activeMsgs.length === 0 && msgs.some((m) => m.is_trash === 1)) ? 1 : 0;
  const inSpam = msgs.every((m) => m.is_spam === 1) || (activeMsgs.length === 0 && msgs.some((m) => m.is_spam === 1)) ? 1 : 0;
  const inSent = activeMsgs.some((m) => m.folder_role === 'sent') ? 1 : 0;
  const inInbox =
    !isSnoozed &&
    !inTrash &&
    !inSpam &&
    activeMsgs.some((m) => !m.is_archived && m.folder_role !== 'sent' && m.folder_role !== 'archive')
      ? 1
      : 0;
  const inArchive =
    !isSnoozed && !inTrash && !inSpam && !inInbox && activeMsgs.some((m) => m.is_archived === 1 || m.folder_role === 'archive')
      ? 1
      : 0;

  const seenAddrs = new Set<string>();
  const participants: EmailParticipant[] = [];
  for (const m of pool) {
    const addr = m.from_address.toLowerCase();
    if (addr && !seenAddrs.has(addr)) {
      seenAddrs.add(addr);
      participants.push({ name: m.from_name || m.from_address, address: m.from_address });
    }
  }

  db.prepare(
    `UPDATE threads
     SET subject = ?, snippet = ?, last_message_at = ?, message_count = ?, unread_count = ?,
         is_starred = ?, is_important = ?, has_attachments = ?,
         in_inbox = ?, in_sent = ?, in_archive = ?, in_spam = ?, in_trash = ?,
         category_slug = ?, participants_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    msgs[0].subject,
    latest.snippet,
    latest.received_at,
    pool.length,
    unreadCount,
    isStarred,
    isImportant,
    hasAttachments,
    inInbox,
    inSent,
    inArchive,
    inSpam,
    inTrash,
    latest.category_slug,
    JSON.stringify(participants),
    new Date().toISOString(),
    threadId
  );
}

function findTargetThreadId(
  db: DatabaseSync,
  userId: string,
  accountId: string,
  payload: RemoteMessagePayload
): string | null {
  if (payload.remoteThreadId) {
    const byRemote = db
      .prepare('SELECT id FROM threads WHERE account_id = ? AND remote_thread_id = ? LIMIT 1')
      .get(accountId, payload.remoteThreadId) as { id: string } | undefined;
    if (byRemote) return byRemote.id;
  }

  if (payload.inReplyTo) {
    const byReply = db
      .prepare('SELECT thread_id FROM messages WHERE account_id = ? AND message_id_header = ? LIMIT 1')
      .get(accountId, payload.inReplyTo) as { thread_id: string } | undefined;
    if (byReply) return byReply.thread_id;
  }

  if (payload.referencesHeader) {
    const refs = payload.referencesHeader.split(/\s+/).filter(Boolean);
    for (const ref of refs) {
      const byRef = db
        .prepare('SELECT thread_id FROM messages WHERE account_id = ? AND message_id_header = ? LIMIT 1')
        .get(accountId, ref) as { thread_id: string } | undefined;
      if (byRef) return byRef.thread_id;
    }
  }

  const norm = normalizeSubject(payload.subject);
  if (norm) {
    const candidates = db
      .prepare('SELECT id, subject FROM threads WHERE user_id = ? AND account_id = ? ORDER BY last_message_at DESC LIMIT 40')
      .all(userId, accountId) as Array<{ id: string; subject: string }>;
    for (const c of candidates) {
      if (normalizeSubject(c.subject) === norm) return c.id;
    }
  }
  return null;
}

export function ingestMessage(
  db: DatabaseSync,
  userId: string,
  accountId: string,
  payload: RemoteMessagePayload,
  opts: { skipNotifications?: boolean; skipRules?: boolean; explicitCategory?: string } = {}
): { messageId: string; threadId: string; inserted: boolean } {
  const targetRolePre: SystemFolderRole = payload.isTrash
    ? 'trash'
    : payload.isSpam
    ? 'spam'
    : payload.folderRole || (payload.isArchived ? 'archive' : 'inbox');

  // Duplicate prevention by remoteId or messageIdHeader within account + folder role
  if (payload.remoteId) {
    const dup = db
      .prepare('SELECT id, thread_id FROM messages WHERE account_id = ? AND remote_id = ? LIMIT 1')
      .get(accountId, payload.remoteId) as { id: string; thread_id: string } | undefined;
    if (dup) {
      return { messageId: dup.id, threadId: dup.thread_id, inserted: false };
    }
  }

  if (payload.messageIdHeader) {
    const dupHdr = db
      .prepare(
        `SELECT m.id, m.thread_id
         FROM messages m
         LEFT JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ? AND m.message_id_header = ? AND COALESCE(f.system_role, 'inbox') = ?
         LIMIT 1`
      )
      .get(accountId, payload.messageIdHeader, targetRolePre) as { id: string; thread_id: string } | undefined;
    if (dupHdr) {
      return { messageId: dupHdr.id, threadId: dupHdr.thread_id, inserted: false };
    }
  }

  // Check blocked senders
  const senderDomain = (payload.fromAddress.split('@')[1] || '').toLowerCase();
  const isBlocked = Boolean(
    db
      .prepare(
        'SELECT id FROM blocked_senders WHERE user_id = ? AND (lower(email_or_domain) = lower(?) OR lower(email_or_domain) = lower(?)) LIMIT 1'
      )
      .get(userId, payload.fromAddress, senderDomain)
  );

  const sanitized = sanitizeEmailContent(payload.rawHtml, payload.rawText);
  const category = opts.explicitCategory || inferCategory(payload.subject, sanitized.text, payload.fromAddress);

  const isKnownContact = Boolean(
    db.prepare('SELECT id FROM contacts WHERE user_id = ? AND lower(email) = lower(?) LIMIT 1').get(userId, payload.fromAddress)
  );
  const priorityScore = computePriorityScore(
    payload.fromAddress,
    payload.subject,
    sanitized.text,
    payload.isImportant,
    payload.isStarred,
    category,
    isKnownContact
  );

  const targetRole: SystemFolderRole = isBlocked
    ? 'spam'
    : payload.isTrash
    ? 'trash'
    : payload.isSpam
    ? 'spam'
    : payload.folderRole || (payload.isArchived ? 'archive' : 'inbox');

  const folderId = getOrCreateFolderByRole(db, userId, accountId, targetRole);
  const now = new Date().toISOString();

  let threadId = findTargetThreadId(db, userId, accountId, payload);
  if (!threadId) {
    threadId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO threads (id, user_id, account_id, remote_thread_id, subject, snippet, last_message_at, message_count, unread_count,
        is_starred, is_important, is_pinned, in_inbox, in_sent, in_archive, in_spam, in_trash, has_attachments,
        category_slug, priority_score, participants_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, '[]', ?, ?)`
    ).run(
      threadId,
      userId,
      accountId,
      payload.remoteThreadId || null,
      payload.subject || '(no subject)',
      sanitized.snippet,
      payload.receivedAt || now,
      payload.isStarred ? 1 : 0,
      payload.isImportant ? 1 : 0,
      category,
      priorityScore,
      now,
      now
    );
  } else {
    // Re-awaken snoozed thread on new reply if incoming
    if (targetRole === 'inbox') {
      db.prepare('UPDATE threads SET snoozed_until = NULL, priority_score = MAX(priority_score, ?) WHERE id = ?').run(
        priorityScore,
        threadId
      );
    }
  }

  const messageId = crypto.randomUUID();
  const hasAttachments = payload.attachments.length > 0;
  const sizeBytes = Buffer.byteLength(payload.rawHtml || payload.rawText || '', 'utf8') +
    payload.attachments.reduce((acc, a) => acc + a.content.byteLength, 0);

  db.prepare(
    `INSERT INTO messages (
      id, thread_id, user_id, account_id, remote_id, message_id_header, in_reply_to, references_header, folder_id,
      from_name, from_address, to_json, cc_json, bcc_json, reply_to_json, subject,
      body_html_sanitized, body_text, snippet, has_external_images, suspicious_links_json, auth_results_json,
      sent_at, received_at, is_read, is_starred, is_important, is_draft, is_spam, is_trash, is_archived,
      has_attachments, category_slug, size_bytes, raw_headers_json, sync_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`
  ).run(
    messageId,
    threadId,
    userId,
    accountId,
    payload.remoteId || null,
    payload.messageIdHeader || `<${messageId}@cadence.local>`,
    payload.inReplyTo || '',
    payload.referencesHeader || '',
    folderId,
    payload.fromName || '',
    payload.fromAddress,
    JSON.stringify(payload.to),
    JSON.stringify(payload.cc),
    JSON.stringify(payload.bcc),
    JSON.stringify(payload.replyTo),
    payload.subject || '(no subject)',
    sanitized.html,
    sanitized.text,
    sanitized.snippet,
    sanitized.hasExternalImages ? 1 : 0,
    JSON.stringify(sanitized.suspiciousLinks),
    JSON.stringify(payload.authResults || { spf: 'pass', dkim: 'pass', dmarc: 'pass' }),
    payload.sentAt || now,
    payload.receivedAt || now,
    payload.isRead ? 1 : 0,
    payload.isStarred ? 1 : 0,
    payload.isImportant ? 1 : 0,
    payload.isDraft ? 1 : 0,
    isBlocked || payload.isSpam ? 1 : 0,
    payload.isTrash ? 1 : 0,
    payload.isArchived ? 1 : 0,
    hasAttachments ? 1 : 0,
    category,
    sizeBytes,
    JSON.stringify(payload.rawHeaders || {}),
    now
  );

  // Store attachments on disk and insert metadata
  const attachmentNames: string[] = [];
  const attStmt = db.prepare(
    `INSERT INTO attachments (id, message_id, draft_id, user_id, filename, mime_type, size_bytes, content_id, is_inline, storage_path, sha256, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const att of payload.attachments) {
    const stored = storeAttachmentBuffer(userId, att.filename, att.mimeType, att.content, {
      messageId,
      contentId: att.contentId,
      isInline: att.isInline,
    });
    attachmentNames.push(att.filename);
    attStmt.run(
      stored.id,
      messageId,
      userId,
      att.filename,
      att.mimeType,
      stored.sizeBytes,
      att.contentId || '',
      att.isInline ? 1 : 0,
      stored.storagePath,
      stored.sha256,
      now
    );
  }

  // Insert labels if provided
  if (payload.labelNames && payload.labelNames.length > 0) {
    for (const labelName of payload.labelNames) {
      let labelRow = db
        .prepare('SELECT id FROM labels WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1')
        .get(userId, labelName) as { id: string } | undefined;
      if (!labelRow) {
        const lid = crypto.randomUUID();
        db.prepare('INSERT INTO labels (id, user_id, account_id, name, color, sort_order, is_favorite, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)').run(
          lid,
          userId,
          accountId,
          labelName,
          '#2563EB',
          now
        );
        labelRow = { id: lid };
      }
      db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)').run(messageId, labelRow.id);
    }
  }

  // Update FTS5 index
  const recipientsText = [...payload.to, ...payload.cc, ...payload.bcc].map((p) => `${p.name} ${p.address}`).join(' ');
  db.prepare(
    `INSERT INTO messages_fts (message_id, user_id, subject, body_text, from_name, from_address, recipients_text, attachment_names)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    messageId,
    userId,
    payload.subject || '',
    sanitized.text,
    payload.fromName || '',
    payload.fromAddress,
    recipientsText,
    attachmentNames.join(' ')
  );

  // Apply user rules for incoming inbox messages
  let ruleNotified = false;
  if (!opts.skipRules && targetRole === 'inbox' && !payload.isDraft) {
    const rules = loadUserRules(db, userId, accountId);
    const labelRows = db.prepare('SELECT label_id FROM message_labels WHERE message_id = ?').all(messageId) as Array<{
      label_id: string;
    }>;
    const evalMsg = {
      id: messageId,
      accountId,
      threadId,
      fromName: payload.fromName,
      fromAddress: payload.fromAddress,
      to: payload.to,
      cc: payload.cc,
      subject: payload.subject,
      bodyText: sanitized.text,
      hasAttachments,
      receivedAt: payload.receivedAt || now,
      labelIds: labelRows.map((l) => l.label_id),
      categorySlug: category,
      isRead: Boolean(payload.isRead),
      isStarred: Boolean(payload.isStarred),
      isImportant: Boolean(payload.isImportant),
      rawHeaders: payload.rawHeaders,
    };
    for (const rule of rules) {
      if (doesRuleMatch(rule.matchMode, rule.conditions, evalMsg)) {
        const outcome = applyRuleActionsToMessage(db, userId, evalMsg, rule.actions, rule.name, rule.id);
        if (outcome.notify) ruleNotified = true;
        if (outcome.createdTask) eventBus.emit(userId, 'task_updated', { threadId });
        if (outcome.createdEvent) eventBus.emit(userId, 'calendar_updated', { threadId });
        if (rule.stopProcessing) break;
      }
    }
  }

  recomputeThreadState(db, threadId);

  if (!opts.skipNotifications && !payload.isRead && targetRole === 'inbox' && !isBlocked) {
    if (!ruleNotified) {
      createUserNotification(db, {
        userId,
        accountId,
        threadId,
        messageId,
        type: 'new_mail',
        title: payload.fromName || payload.fromAddress,
        body: `${payload.subject} — ${sanitized.snippet}`,
        categorySlug: category,
        isImportant: Boolean(payload.isImportant),
      });
    }
    eventBus.emit(userId, 'new_message', {
      threadId,
      messageId,
      accountId,
      subject: payload.subject,
      from: payload.fromName || payload.fromAddress,
      snippet: sanitized.snippet,
    });
  }

  return { messageId, threadId, inserted: true };
}
