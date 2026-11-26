import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { AttachmentInput, ProviderCredentials } from '../providers/types.js';
import { decryptSecret } from '../security/crypto.js';
import { htmlToPlainText, sanitizeComposerHtml } from '../security/sanitize.js';
import { DEFAULT_USER_PREFERENCES, type EmailParticipant, type ProviderType } from '../types.js';
import { processDueScheduledAutomations } from './automationService.js';
import { eventBus } from './eventBus.js';
import { enqueueHostedOutgoingMail, processMailQueue, recomputeAccountUsageBytes } from './mailDeliveryEngine.js';
import { createUserNotification } from './notificationService.js';
import { syncConnectedAccountsWithBackoff } from './syncService.js';
import { ingestMessage, recomputeThreadState } from './threadService.js';

export async function dispatchDraftNow(
  db: DatabaseSync,
  draftId: string
): Promise<{ ok: boolean; error?: string; messageId?: string; threadId?: string }> {
  const draft = db
    .prepare('SELECT * FROM drafts WHERE id = ?')
    .get(draftId) as
    | {
        id: string;
        user_id: string;
        account_id: string;
        thread_id: string | null;
        reply_to_message_id: string | null;
        mode: string;
        to_json: string;
        cc_json: string;
        bcc_json: string;
        subject: string;
        body_html: string;
        body_text: string;
        is_plain_text: number;
        status: string;
      }
    | undefined;

  if (!draft) return { ok: false, error: 'Draft not found' };

  const account = db
    .prepare(
      'SELECT id, user_id, provider_type, domain_id, email_address, display_name, encrypted_credentials, status FROM accounts WHERE id = ? AND user_id = ?'
    )
    .get(draft.account_id, draft.user_id) as
    | {
        id: string;
        user_id: string;
        provider_type: ProviderType;
        domain_id: string | null;
        email_address: string;
        display_name: string;
        encrypted_credentials: string;
        status: string;
      }
    | undefined;

  if (!account) {
    db.prepare("UPDATE drafts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(
      'Sending account not found',
      new Date().toISOString(),
      draftId
    );
    return { ok: false, error: 'Sending account not found' };
  }

  const to = JSON.parse(draft.to_json) as EmailParticipant[];
  const cc = JSON.parse(draft.cc_json) as EmailParticipant[];
  const bcc = JSON.parse(draft.bcc_json) as EmailParticipant[];

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    db.prepare("UPDATE drafts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(
      'At least one recipient is required',
      new Date().toISOString(),
      draftId
    );
    return { ok: false, error: 'At least one recipient is required' };
  }

  let inReplyTo = '';
  let referencesHeader = '';
  if (draft.reply_to_message_id) {
    const orig = db
      .prepare('SELECT message_id_header, references_header FROM messages WHERE id = ?')
      .get(draft.reply_to_message_id) as { message_id_header: string; references_header: string } | undefined;
    if (orig) {
      inReplyTo = orig.message_id_header;
      referencesHeader = [orig.references_header, orig.message_id_header].filter(Boolean).join(' ');
    }
  }

  const attRows = db
    .prepare('SELECT * FROM attachments WHERE draft_id = ?')
    .all(draftId) as Array<{
    id: string;
    filename: string;
    mime_type: string;
    content_id: string;
    is_inline: number;
    storage_path: string;
  }>;

  const attachments: AttachmentInput[] = [];
  for (const att of attRows) {
    if (fs.existsSync(att.storage_path)) {
      attachments.push({
        filename: att.filename,
        mimeType: att.mime_type,
        content: fs.readFileSync(att.storage_path),
        contentId: att.content_id || undefined,
        isInline: Boolean(att.is_inline),
      });
    }
  }

  const cleanHtml = draft.is_plain_text ? '' : sanitizeComposerHtml(draft.body_html);
  const plainText = draft.body_text?.trim() ? draft.body_text : htmlToPlainText(cleanHtml);

  if (account.status === 'suspended' || account.status === 'disconnected') {
    db.prepare("UPDATE drafts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(
      `Account is ${account.status}`,
      new Date().toISOString(),
      draftId
    );
    return { ok: false, error: `Account is ${account.status}` };
  }

  try {
    const credentials: ProviderCredentials =
      account.provider_type === 'hosted'
        ? { type: 'hosted', domainId: account.domain_id || '' }
        : account.provider_type === 'local'
        ? { type: 'local' }
        : (JSON.parse(decryptSecret(account.encrypted_credentials)) as ProviderCredentials);

    const adapter = getProviderAdapter(account.provider_type);
    const sendRes = await adapter.sendMessage(credentials, {
      fromName: account.display_name,
      fromAddress: account.email_address,
      to,
      cc,
      bcc,
      subject: draft.subject || '(no subject)',
      html: cleanHtml,
      text: plainText,
      inReplyTo,
      referencesHeader,
      attachments,
    });

    const now = new Date().toISOString();

    // Save sent message into sender's Sent folder
    const sentIngest = ingestMessage(
      db,
      draft.user_id,
      account.id,
      {
        remoteId: `sent-${sendRes.remoteId}`,
        remoteThreadId: sendRes.remoteThreadId,
        messageIdHeader: sendRes.messageIdHeader,
        inReplyTo,
        referencesHeader,
        folderRole: 'sent',
        fromName: account.display_name,
        fromAddress: account.email_address,
        to,
        cc,
        bcc,
        replyTo: [],
        subject: draft.subject || '(no subject)',
        rawHtml: cleanHtml || `<pre>${plainText}</pre>`,
        rawText: plainText,
        sentAt: now,
        receivedAt: now,
        isRead: true,
        isStarred: false,
        isImportant: false,
        isDraft: false,
        isSpam: false,
        isTrash: false,
        isArchived: false,
        attachments,
      },
      { skipNotifications: true, skipRules: true }
    );

    if (account.provider_type === 'hosted' || account.provider_type === 'local') {
      await enqueueHostedOutgoingMail(db, {
        userId: draft.user_id,
        accountId: account.id,
        draftId,
        sentMessageId: sentIngest.messageId,
        messageIdHeader: sendRes.messageIdHeader,
        fromName: account.display_name,
        fromAddress: account.email_address,
        to,
        cc,
        bcc,
        subject: draft.subject || '(no subject)',
        html: cleanHtml,
        text: plainText,
        inReplyTo,
        referencesHeader,
        attachments,
      });
    } else {
      db.prepare(
        "UPDATE messages SET delivery_status = 'accepted_by_mx', delivery_detail = ? WHERE id = ?"
      ).run(`Accepted by ${account.provider_type} transport`, sentIngest.messageId);
    }

    recomputeAccountUsageBytes(db, account.id);

    // Update contact history for frequent suggestions
    for (const r of [...to, ...cc, ...bcc]) {
      const existingContact = db
        .prepare('SELECT id FROM contacts WHERE user_id = ? AND lower(email) = lower(?)')
        .get(draft.user_id, r.address) as { id: string } | undefined;
      if (existingContact) {
        db.prepare('UPDATE contacts SET contact_count = contact_count + 1, last_contacted_at = ?, updated_at = ? WHERE id = ?').run(
          now,
          now,
          existingContact.id
        );
      } else {
        db.prepare(
          `INSERT INTO contacts (id, user_id, name, email, organization, phone, notes, avatar_color, is_favorite, contact_count, last_contacted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', '', '', '#2563EB', 0, 1, ?, ?, ?)`
        ).run(crypto.randomUUID(), draft.user_id, r.name || r.address.split('@')[0], r.address, now, now, now);
      }
    }

    db.prepare("UPDATE drafts SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?").run(now, draftId);

    eventBus.emit(draft.user_id, 'message_sent', {
      draftId,
      messageId: sentIngest.messageId,
      threadId: sentIngest.threadId,
      subject: draft.subject,
    });

    return { ok: true, messageId: sentIngest.messageId, threadId: sentIngest.threadId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Message delivery failed';
    db.prepare("UPDATE drafts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(
      errMsg,
      new Date().toISOString(),
      draftId
    );
    eventBus.emit(draft.user_id, 'send_failed', { draftId, error: errMsg });
    return { ok: false, error: errMsg };
  }
}

export async function processDueBackgroundJobs(db: DatabaseSync = getDb()): Promise<void> {
  const nowIso = new Date().toISOString();

  // 1. Due undo-send drafts
  const dueUndo = db
    .prepare("SELECT id FROM drafts WHERE status = 'queued_undo' AND undo_send_until <= ?")
    .all(nowIso) as Array<{ id: string }>;

  for (const row of dueUndo) {
    const claimed = db
      .prepare("UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued_undo'")
      .run(nowIso, row.id);
    if (claimed.changes > 0) {
      await dispatchDraftNow(db, row.id);
    }
  }

  // 2. Due scheduled emails
  const dueScheduled = db
    .prepare("SELECT id FROM drafts WHERE status = 'scheduled' AND scheduled_for <= ?")
    .all(nowIso) as Array<{ id: string }>;

  for (const row of dueScheduled) {
    const claimed = db
      .prepare("UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .run(nowIso, row.id);
    if (claimed.changes > 0) {
      await dispatchDraftNow(db, row.id);
    }
  }

  // 3. Due snoozed threads
  const dueSnoozed = db
    .prepare('SELECT id, user_id, account_id, subject FROM threads WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?')
    .all(nowIso) as Array<{ id: string; user_id: string; account_id: string; subject: string }>;

  for (const th of dueSnoozed) {
    db.prepare('UPDATE threads SET snoozed_until = NULL, snooze_restore_folder_id = NULL, updated_at = ? WHERE id = ?').run(
      nowIso,
      th.id
    );
    db.prepare('UPDATE messages SET is_archived = 0, is_read = 0 WHERE thread_id = ? AND is_trash = 0 AND is_spam = 0').run(th.id);
    recomputeThreadState(db, th.id);
    createUserNotification(db, {
      userId: th.user_id,
      accountId: th.account_id,
      threadId: th.id,
      messageId: null,
      type: 'snooze_wake',
      title: 'Snoozed thread returned to Inbox',
      body: th.subject,
    });
    eventBus.emit(th.user_id, 'thread_updated', { threadId: th.id, reason: 'snooze_wake' });
  }

  // 4. Due reminders
  const dueReminders = db
    .prepare("SELECT id, user_id, thread_id, message_id, title FROM reminders WHERE status = 'pending' AND due_at <= ?")
    .all(nowIso) as Array<{ id: string; user_id: string; thread_id: string | null; message_id: string | null; title: string }>;

  for (const rem of dueReminders) {
    const claimed = db
      .prepare("UPDATE reminders SET status = 'triggered' WHERE id = ? AND status = 'pending'")
      .run(rem.id);
    if (claimed.changes > 0) {
      createUserNotification(db, {
        userId: rem.user_id,
        accountId: null,
        threadId: rem.thread_id,
        messageId: rem.message_id,
        type: 'reminder',
        title: 'Follow-up reminder',
        body: rem.title,
      });
      eventBus.emit(rem.user_id, 'reminder_due', { reminderId: rem.id, title: rem.title, threadId: rem.thread_id });
    }
  }

  // 5. Due recurring scheduled automations
  await processDueScheduledAutomations(db, dispatchDraftNow);
}

/** Deletes specified non-draft message rows, unlinks unreferenced attachments, and updates thread/quota state. */
function purgeMessageRows(
  db: DatabaseSync,
  userId: string,
  rows: Array<{ id: string; thread_id: string; account_id: string }>,
  reason: string
): { deletedMessages: number; deletedThreads: number } {
  if (rows.length === 0) return { deletedMessages: 0, deletedThreads: 0 };

  let deletedMessages = 0;
  let deletedThreads = 0;
  const touchedThreads = new Set<string>();
  const touchedAccounts = new Set<string>();
  const attSelect = db.prepare('SELECT storage_path FROM attachments WHERE message_id = ?');
  const delFts = db.prepare('DELETE FROM messages_fts WHERE message_id = ?');
  const delMsg = db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?');

  for (const m of rows) {
    const atts = attSelect.all(m.id) as Array<{ storage_path: string }>;
    for (const a of atts) {
      if (a.storage_path && fs.existsSync(a.storage_path)) {
        try {
          fs.unlinkSync(a.storage_path);
        } catch {
          // ignore unlink errors
        }
      }
    }
    delFts.run(m.id);
    delMsg.run(m.id, userId);
    deletedMessages += 1;
    touchedThreads.add(m.thread_id);
    touchedAccounts.add(m.account_id);
  }

  for (const tid of touchedThreads) {
    const remaining = (
      db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE thread_id = ? AND is_draft = 0').get(tid) as { cnt: number }
    ).cnt;
    if (remaining === 0) {
      db.prepare('DELETE FROM threads WHERE id = ?').run(tid);
      deletedThreads += 1;
    } else {
      recomputeThreadState(db, tid);
    }
  }

  for (const acctId of touchedAccounts) {
    recomputeAccountUsageBytes(db, acctId);
  }

  eventBus.emit(userId, 'thread_updated', { reason, deletedMessages });
  return { deletedMessages, deletedThreads };
}

/** Permanently removes all messages in a user's Trash or Spam system view (optionally scoped to one account). */
export function emptySystemFolder(
  db: DatabaseSync,
  userId: string,
  folder: 'trash' | 'spam',
  accountId?: string
): { deletedMessages: number; deletedThreads: number } {
  const flagCol = folder === 'trash' ? 'is_trash' : 'is_spam';
  const rows = accountId
    ? (db
        .prepare(`SELECT id, thread_id, account_id FROM messages WHERE user_id = ? AND account_id = ? AND is_draft = 0 AND ${flagCol} = 1`)
        .all(userId, accountId) as Array<{ id: string; thread_id: string; account_id: string }>)
    : (db
        .prepare(`SELECT id, thread_id, account_id FROM messages WHERE user_id = ? AND is_draft = 0 AND ${flagCol} = 1`)
        .all(userId) as Array<{ id: string; thread_id: string; account_id: string }>);
  return purgeMessageRows(db, userId, rows, `empty_${folder}`);
}

/** Purges trash and spam messages older than each user's configured retention window. */
export function purgeExpiredRetentionMessages(
  db: DatabaseSync = getDb(),
  targetUserId?: string
): { deletedMessages: number; deletedThreads: number } {
  const userRows = targetUserId
    ? ([{ id: targetUserId }] as Array<{ id: string }>)
    : (db.prepare("SELECT id FROM users WHERE status = 'active'").all() as Array<{ id: string }>);

  let deletedMessages = 0;
  let deletedThreads = 0;
  const nowMs = Date.now();
  const defaultTrashDays = DEFAULT_USER_PREFERENCES.retention?.trashRetentionDays ?? 30;
  const defaultSpamDays = DEFAULT_USER_PREFERENCES.retention?.spamRetentionDays ?? 30;

  for (const u of userRows) {
    const prefRow = db
      .prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?')
      .get(u.id) as { preferences_json: string } | undefined;
    let trashDays = defaultTrashDays;
    let spamDays = defaultSpamDays;
    if (prefRow) {
      try {
        const parsed = JSON.parse(prefRow.preferences_json);
        if (typeof parsed?.retention?.trashRetentionDays === 'number' && parsed.retention.trashRetentionDays >= 1) {
          trashDays = parsed.retention.trashRetentionDays;
        }
        if (typeof parsed?.retention?.spamRetentionDays === 'number' && parsed.retention.spamRetentionDays >= 1) {
          spamDays = parsed.retention.spamRetentionDays;
        }
      } catch {
        // use defaults
      }
    }

    const trashCutoff = new Date(nowMs - trashDays * 86_400_000).toISOString();
    const spamCutoff = new Date(nowMs - spamDays * 86_400_000).toISOString();

    const expired = db
      .prepare(
        `SELECT id, thread_id, account_id FROM messages
         WHERE user_id = ? AND is_draft = 0
           AND ((is_trash = 1 AND COALESCE(received_at, created_at) <= ?)
             OR (is_spam = 1 AND COALESCE(received_at, created_at) <= ?))`
      )
      .all(u.id, trashCutoff, spamCutoff) as Array<{ id: string; thread_id: string; account_id: string }>;

    const res = purgeMessageRows(db, u.id, expired, 'retention_purge');
    deletedMessages += res.deletedMessages;
    deletedThreads += res.deletedThreads;
  }

  return { deletedMessages, deletedThreads };
}

let workerTimer: NodeJS.Timeout | null = null;
let lastSyncSweepAt = 0;
let syncSweepInFlight = false;
let lastRetentionSweepAt = 0;

export function startBackgroundWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void processDueBackgroundJobs().catch((err) => {
      console.error('[Cadence worker] error:', err);
    });
    void processMailQueue().catch((err) => {
      console.error('[Cadence MTA worker] error:', err);
    });
    const now = Date.now();
    if (!syncSweepInFlight && now - lastSyncSweepAt >= 90_000) {
      syncSweepInFlight = true;
      lastSyncSweepAt = now;
      void syncConnectedAccountsWithBackoff()
        .catch((err) => console.error('[Cadence sync sweep] error:', err))
        .finally(() => {
          syncSweepInFlight = false;
        });
    }
    if (now - lastRetentionSweepAt >= 3_600_000) {
      lastRetentionSweepAt = now;
      try {
        purgeExpiredRetentionMessages();
      } catch (err) {
        console.error('[Cadence retention sweep] error:', err);
      }
    }
  }, 2000);
}

export function stopBackgroundWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
