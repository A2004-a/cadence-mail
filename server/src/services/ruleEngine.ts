import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EmailParticipant } from '../types.js';
import { cloneFilesToDraft, expandAutomationMessage } from './automationService.js';
import { createUserNotification } from './notificationService.js';

export type RuleField =
  | 'from'
  | 'to'
  | 'subject'
  | 'body'
  | 'keywords'
  | 'domain'
  | 'has_attachment'
  | 'date_after'
  | 'date_before'
  | 'label'
  | 'category'
  | 'is_read'
  | 'is_starred'
  | 'is_important';
export type RuleOperator =
  | 'contains'
  | 'contains_any'
  | 'regex'
  | 'not_contains'
  | 'equals'
  | 'starts_with'
  | 'ends_with'
  | 'is_true'
  | 'is_false'
  | 'after'
  | 'before';

export interface RuleCondition {
  field: RuleField;
  operator: RuleOperator;
  value: string;
}

export type RuleActionType =
  | 'move_to_folder'
  | 'apply_label'
  | 'mark_read'
  | 'mark_unread'
  | 'mark_important'
  | 'archive'
  | 'star'
  | 'skip_inbox'
  | 'notify'
  | 'categorize'
  | 'forward'
  | 'create_task'
  | 'create_reminder'
  | 'create_event'
  | 'generate_draft'
  | 'auto_reply';

export interface RuleAction {
  type: RuleActionType;
  value?: string;
  subject?: string;
  attachmentIds?: string[];
  infoProfileIds?: string[];
  includeOriginalAttachments?: boolean;
}

export interface RuleRecord {
  id: string;
  userId: string;
  accountId: string | null;
  name: string;
  enabled: boolean;
  priorityOrder: number;
  matchMode: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing: boolean;
}

export interface EvaluableMessage {
  id: string;
  accountId: string;
  threadId: string;
  fromName: string;
  fromAddress: string;
  to: EmailParticipant[];
  cc: EmailParticipant[];
  subject: string;
  bodyText: string;
  hasAttachments: boolean;
  receivedAt: string;
  labelIds: string[];
  categorySlug?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  rawHeaders?: Record<string, string | string[]>;
}

/** Detects mailing lists, auto-responders, and RFC 3834 headers to prevent auto-reply/forward loops. */
function getAutomatedSkipReason(msg: EvaluableMessage): string | null {
  const senderLower = msg.fromAddress.toLowerCase();
  if (/no-?reply|mailer-daemon|postmaster|notifications@/i.test(senderLower)) {
    return 'automated sender address';
  }
  if (msg.subject.startsWith('[Auto-Reply]') || msg.subject.startsWith('[Auto-Fwd]')) {
    return 'auto-generated subject prefix';
  }
  const headers = msg.rawHeaders || {};
  for (const [k, rawVal] of Object.entries(headers)) {
    const key = k.toLowerCase();
    const val = Array.isArray(rawVal) ? rawVal.join(' ').toLowerCase() : String(rawVal || '').toLowerCase();
    if (key === 'auto-submitted' && val.trim() && val.trim() !== 'no') {
      return 'RFC 3834 Auto-Submitted header';
    }
    if (key === 'precedence' && /\b(bulk|list|junk|auto_reply)\b/i.test(val)) {
      return 'bulk/list Precedence header';
    }
    if (key === 'list-unsubscribe' && val.trim()) {
      return 'mailing-list List-Unsubscribe header';
    }
    if (key === 'x-auto-response-suppress' && /\b(all|oof|dr|rn|nrn|auto)\b/i.test(val)) {
      return 'X-Auto-Response-Suppress header';
    }
  }
  return null;
}

export function evaluateCondition(cond: RuleCondition, msg: EvaluableMessage): boolean {
  const val = (cond.value || '').trim().toLowerCase();
  const fromStr = `${msg.fromName} ${msg.fromAddress}`.toLowerCase();
  const toStr = [...msg.to, ...msg.cc].map((p) => `${p.name} ${p.address}`).join(' ').toLowerCase();
  const domain = (msg.fromAddress.split('@')[1] || '').toLowerCase();

  let haystack = '';
  switch (cond.field) {
    case 'from':
      haystack = fromStr;
      break;
    case 'to':
      haystack = toStr;
      break;
    case 'subject':
      haystack = msg.subject.toLowerCase();
      break;
    case 'body':
      haystack = msg.bodyText.toLowerCase();
      break;
    case 'keywords':
      haystack = `${msg.subject} ${msg.bodyText} ${fromStr}`.toLowerCase();
      break;
    case 'domain':
      haystack = domain;
      break;
    case 'category':
      haystack = (msg.categorySlug || '').toLowerCase();
      break;
    case 'has_attachment':
      return cond.operator === 'is_false' ? !msg.hasAttachments : msg.hasAttachments;
    case 'is_read':
      return cond.operator === 'is_false' ? !msg.isRead : Boolean(msg.isRead);
    case 'is_starred':
      return cond.operator === 'is_false' ? !msg.isStarred : Boolean(msg.isStarred);
    case 'is_important':
      return cond.operator === 'is_false' ? !msg.isImportant : Boolean(msg.isImportant);
    case 'date_after':
      return new Date(msg.receivedAt).getTime() >= new Date(cond.value).getTime();
    case 'date_before':
      return new Date(msg.receivedAt).getTime() <= new Date(cond.value).getTime();
    case 'label':
      return msg.labelIds.some((id) => id.toLowerCase() === val);
  }

  switch (cond.operator) {
    case 'contains':
      return haystack.includes(val);
    case 'contains_any': {
      const tokens = val
        .split(/[,|]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      return tokens.length > 0 && tokens.some((tok) => haystack.includes(tok));
    }
    case 'regex': {
      const pattern = (cond.value || '').trim();
      if (!pattern || pattern.length > 160) return false;
      try {
        return new RegExp(pattern, 'i').test(haystack);
      } catch {
        return false;
      }
    }
    case 'not_contains':
      return !haystack.includes(val);
    case 'equals':
      return haystack.trim() === val;
    case 'starts_with':
      return haystack.startsWith(val);
    case 'ends_with':
      return haystack.endsWith(val);
    case 'is_true':
      return Boolean(haystack.trim());
    case 'is_false':
      return !haystack.trim();
    case 'after':
      return new Date(msg.receivedAt).getTime() >= new Date(cond.value).getTime();
    case 'before':
      return new Date(msg.receivedAt).getTime() <= new Date(cond.value).getTime();
  }
}

export function doesRuleMatch(
  matchMode: 'all' | 'any',
  conditions: RuleCondition[],
  msg: EvaluableMessage
): boolean {
  if (conditions.length === 0) return false;
  if (matchMode === 'all') {
    return conditions.every((c) => evaluateCondition(c, msg));
  }
  return conditions.some((c) => evaluateCondition(c, msg));
}

export function loadUserRules(db: DatabaseSync, userId: string, accountId?: string): RuleRecord[] {
  const rows = db
    .prepare(
      `SELECT id, user_id, account_id, name, enabled, priority_order, match_mode, conditions_json, actions_json, stop_processing
       FROM rules
       WHERE user_id = ? AND enabled = 1 AND (account_id IS NULL OR account_id = ?)
       ORDER BY priority_order ASC, created_at ASC`
    )
    .all(userId, accountId || '') as Array<{
    id: string;
    user_id: string;
    account_id: string | null;
    name: string;
    enabled: number;
    priority_order: number;
    match_mode: 'all' | 'any';
    conditions_json: string;
    actions_json: string;
    stop_processing: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    accountId: r.account_id,
    name: r.name,
    enabled: Boolean(r.enabled),
    priorityOrder: r.priority_order,
    matchMode: r.match_mode,
    conditions: JSON.parse(r.conditions_json) as RuleCondition[],
    actions: JSON.parse(r.actions_json) as RuleAction[],
    stopProcessing: Boolean(r.stop_processing),
  }));
}

export function recordRuleExecutionLog(
  db: DatabaseSync,
  params: {
    ruleId: string;
    userId: string;
    messageId: string | null;
    threadId: string | null;
    status: 'executed' | 'skipped_guard' | 'failed';
    detail: string;
  }
): void {
  db.prepare(
    'INSERT INTO rule_execution_logs (id, rule_id, user_id, message_id, thread_id, status, detail, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), params.ruleId, params.userId, params.messageId, params.threadId, params.status, params.detail.slice(0, 400), new Date().toISOString());
}

export function applyRuleActionsToMessage(
  db: DatabaseSync,
  userId: string,
  msg: EvaluableMessage,
  actions: RuleAction[],
  ruleName: string,
  ruleId?: string
): { notify: boolean; movedToFolderId?: string; skippedByGuard?: boolean; createdTask?: boolean; createdEvent?: boolean } {
  let notify = false;
  let movedToFolderId: string | undefined;
  let createdTask = false;
  let createdEvent = false;
  const executedActions: string[] = [];
  let skippedGuardCount = 0;

  if (ruleId) {
    const alreadyRan = db
      .prepare("SELECT id FROM rule_execution_logs WHERE rule_id = ? AND message_id = ? AND status = 'executed' LIMIT 1")
      .get(ruleId, msg.id);
    if (alreadyRan) {
      return { notify: false, skippedByGuard: true };
    }
  }

  const checkRateLimit = () => {
    if (!ruleId) return true;
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const cntRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM rule_execution_logs WHERE rule_id = ? AND executed_at >= ? AND status = 'executed'")
      .get(ruleId, oneHourAgo) as { cnt: number };
    return cntRow.cnt < 30;
  };

  try {
    for (const action of actions) {
      switch (action.type) {
        case 'mark_read':
          db.prepare('UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ?').run(msg.id, userId);
          executedActions.push('mark_read');
          break;
        case 'mark_unread':
          db.prepare('UPDATE messages SET is_read = 0 WHERE id = ? AND user_id = ?').run(msg.id, userId);
          executedActions.push('mark_unread');
          break;
        case 'mark_important':
          db.prepare('UPDATE messages SET is_important = 1 WHERE id = ? AND user_id = ?').run(msg.id, userId);
          executedActions.push('mark_important');
          break;
        case 'star':
          db.prepare('UPDATE messages SET is_starred = 1 WHERE id = ? AND user_id = ?').run(msg.id, userId);
          executedActions.push('star');
          break;
        case 'archive':
        case 'skip_inbox': {
          const archiveFolder = db
            .prepare("SELECT id FROM folders WHERE account_id = ? AND system_role = 'archive' LIMIT 1")
            .get(msg.accountId) as { id: string } | undefined;
          db.prepare('UPDATE messages SET is_archived = 1, folder_id = COALESCE(?, folder_id) WHERE id = ? AND user_id = ?').run(
            archiveFolder?.id ?? null,
            msg.id,
            userId
          );
          movedToFolderId = archiveFolder?.id;
          executedActions.push(action.type);
          break;
        }
        case 'move_to_folder': {
          if (!action.value) break;
          const folder = db
            .prepare('SELECT id, system_role FROM folders WHERE user_id = ? AND (id = ? OR slug = ? OR lower(name) = lower(?)) AND account_id = ? LIMIT 1')
            .get(userId, action.value, action.value, action.value, msg.accountId) as
            | { id: string; system_role: string }
            | undefined;
          if (folder) {
            db.prepare(
              `UPDATE messages SET folder_id = ?, is_trash = ?, is_spam = ?, is_archived = ? WHERE id = ? AND user_id = ?`
            ).run(
              folder.id,
              folder.system_role === 'trash' ? 1 : 0,
              folder.system_role === 'spam' ? 1 : 0,
              folder.system_role === 'archive' ? 1 : 0,
              msg.id,
              userId
            );
            movedToFolderId = folder.id;
            executedActions.push('move_to_folder');
          }
          break;
        }
        case 'apply_label': {
          if (!action.value) break;
          const label = db
            .prepare('SELECT id FROM labels WHERE user_id = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1')
            .get(userId, action.value, action.value) as { id: string } | undefined;
          if (label) {
            db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)').run(msg.id, label.id);
            executedActions.push('apply_label');
          }
          break;
        }
        case 'categorize': {
          if (!action.value) break;
          db.prepare('UPDATE messages SET category_slug = ? WHERE id = ? AND user_id = ?').run(action.value, msg.id, userId);
          db.prepare('UPDATE threads SET category_slug = ? WHERE id = ? AND user_id = ?').run(
            action.value,
            msg.threadId,
            userId
          );
          executedActions.push('categorize');
          break;
        }
        case 'notify': {
          notify = true;
          createUserNotification(db, {
            userId,
            accountId: msg.accountId,
            threadId: msg.threadId,
            messageId: msg.id,
            type: 'rule_match',
            title: `Rule matched: ${ruleName}`,
            body: `${msg.fromName || msg.fromAddress} — ${msg.subject}`,
            categorySlug: msg.categorySlug,
            isImportant: Boolean(msg.isImportant),
          });
          executedActions.push('notify');
          break;
        }
        case 'create_task': {
          const now = new Date().toISOString();
          const title = (action.value || '').trim() || `Follow up: ${msg.subject}`.slice(0, 180);
          db.prepare(
            `INSERT INTO tasks (id, user_id, title, notes, status, priority, category, due_at, thread_id, message_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'todo', 'medium', 'Email Rule', ?, ?, ?, ?, ?)`
          ).run(
            crypto.randomUUID(),
            userId,
            title,
            `Created automatically by rule "${ruleName}" from ${msg.fromName || msg.fromAddress}.`,
            new Date(Date.now() + 86_400_000).toISOString(),
            msg.threadId,
            msg.id,
            now,
            now
          );
          createdTask = true;
          executedActions.push('create_task');
          break;
        }
        case 'create_reminder': {
          const now = new Date().toISOString();
          const title = (action.value || '').trim() || `Follow up: ${msg.subject}`.slice(0, 180);
          db.prepare(
            "INSERT INTO reminders (id, user_id, thread_id, message_id, title, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
          ).run(
            crypto.randomUUID(),
            userId,
            msg.threadId,
            msg.id,
            title,
            new Date(Date.now() + 86_400_000).toISOString(),
            now
          );
          executedActions.push('create_reminder');
          break;
        }
        case 'create_event': {
          const now = new Date().toISOString();
          const start = new Date(Date.now() + 86_400_000);
          start.setMinutes(0, 0, 0);
          const end = new Date(start.getTime() + 3600_000);
          const title = (action.value || '').trim() || msg.subject.slice(0, 160);
          db.prepare(
            `INSERT INTO calendar_events (
              id, user_id, account_id, thread_id, message_id, title, description, start_at, end_at,
              all_day, timezone, status, attendees_json, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'UTC', 'tentative', ?, 'extracted', ?, ?)`
          ).run(
            crypto.randomUUID(),
            userId,
            msg.accountId,
            msg.threadId,
            msg.id,
            title,
            `Created from rule "${ruleName}"`,
            start.toISOString(),
            end.toISOString(),
            JSON.stringify([{ name: msg.fromName, address: msg.fromAddress }]),
            now,
            now
          );
          createdEvent = true;
          executedActions.push('create_event');
          break;
        }
        case 'generate_draft': {
          const now = new Date().toISOString();
          const acct = db
            .prepare('SELECT display_name, email_address FROM accounts WHERE id = ?')
            .get(msg.accountId) as { display_name: string; email_address: string } | undefined;
          const rawTemplate =
            (action.value || '').trim() ||
            `Hi {{from_name}},\n\nThank you for your email regarding "{{subject}}".\n`;
          const rawSubj = (action.subject || '').trim() || (msg.subject.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject}`);
          const expanded = expandAutomationMessage(db, userId, rawSubj, rawTemplate, {
            account: acct ? { displayName: acct.display_name, emailAddress: acct.email_address } : undefined,
            msg: { fromName: msg.fromName, fromAddress: msg.fromAddress, subject: msg.subject },
            extraInfoProfileIds: action.infoProfileIds,
          });
          const draftId = crypto.randomUUID();
          db.prepare(
            `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'reply', ?, '[]', '[]', ?, ?, ?, 0, 'draft', 1, ?, ?)`
          ).run(
            draftId,
            userId,
            msg.accountId,
            msg.threadId,
            msg.id,
            JSON.stringify([{ name: msg.fromName, address: msg.fromAddress }]),
            expanded.subject,
            expanded.bodyHtml,
            expanded.bodyText,
            now,
            now
          );
          const allAssets = Array.from(new Set([...(action.attachmentIds || []), ...expanded.collectedAssetIds]));
          cloneFilesToDraft(db, userId, draftId, { assetIds: allAssets });
          executedActions.push('generate_draft');
          break;
        }
        case 'auto_reply': {
          const acct = db
            .prepare('SELECT display_name, email_address FROM accounts WHERE id = ?')
            .get(msg.accountId) as { display_name: string; email_address: string } | undefined;
          const isSelfSender = acct && acct.email_address.toLowerCase() === msg.fromAddress.toLowerCase();
          const skipReason = isSelfSender ? 'self-sender loop guard' : getAutomatedSkipReason(msg);
          if (!skipReason && checkRateLimit()) {
            const now = new Date().toISOString();
            const rawTemplate =
              (action.value || '').trim() ||
              `Thank you for your message regarding "{{subject}}". We have received your email and will respond shortly.`;
            const rawSubj = (action.subject || '').trim()
              ? `[Auto-Reply] ${action.subject!.trim()}`
              : `[Auto-Reply] Re: ${msg.subject}`;
            const expanded = expandAutomationMessage(db, userId, rawSubj, rawTemplate, {
              account: acct ? { displayName: acct.display_name, emailAddress: acct.email_address } : undefined,
              msg: { fromName: msg.fromName, fromAddress: msg.fromAddress, subject: msg.subject },
              extraInfoProfileIds: action.infoProfileIds,
            });
            const draftId = crypto.randomUUID();
            db.prepare(
              `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, scheduled_for, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'reply', ?, '[]', '[]', ?, ?, ?, 0, 'scheduled', ?, 1, ?, ?)`
            ).run(
              draftId,
              userId,
              msg.accountId,
              msg.threadId,
              msg.id,
              JSON.stringify([{ name: msg.fromName, address: msg.fromAddress }]),
              expanded.subject.slice(0, 480),
              expanded.bodyHtml,
              expanded.bodyText,
              now,
              now,
              now
            );
            const allAssets = Array.from(new Set([...(action.attachmentIds || []), ...expanded.collectedAssetIds]));
            cloneFilesToDraft(db, userId, draftId, { assetIds: allAssets });
            executedActions.push('auto_reply');
          } else {
            skippedGuardCount += 1;
            if (ruleId) {
              recordRuleExecutionLog(db, {
                ruleId,
                userId,
                messageId: msg.id,
                threadId: msg.threadId,
                status: 'skipped_guard',
                detail: skipReason ? `Auto-reply skipped (${skipReason})` : 'Auto-reply skipped due to hourly rate limit',
              });
            }
          }
          break;
        }
        case 'forward': {
          const targetEmail = (action.value || '').trim().toLowerCase();
          const skipReason = getAutomatedSkipReason(msg);
          if (
            targetEmail &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail) &&
            msg.fromAddress.toLowerCase() !== targetEmail &&
            !skipReason &&
            checkRateLimit()
          ) {
            const now = new Date().toISOString();
            const draftId = crypto.randomUUID();
            const acct = db
              .prepare('SELECT display_name, email_address FROM accounts WHERE id = ?')
              .get(msg.accountId) as { display_name: string; email_address: string } | undefined;
            const fwdSubjRaw = (action.subject || '').trim() ? `[Auto-Fwd] ${action.subject!.trim()}` : `[Auto-Fwd] ${msg.subject}`;
            const expandedExtra = action.infoProfileIds?.length
              ? expandAutomationMessage(db, userId, fwdSubjRaw, '', {
                  account: acct ? { displayName: acct.display_name, emailAddress: acct.email_address } : undefined,
                  msg: { fromName: msg.fromName, fromAddress: msg.fromAddress, subject: msg.subject },
                  extraInfoProfileIds: action.infoProfileIds,
                })
              : null;
            const fwdSubject = (expandedExtra?.subject || fwdSubjRaw).slice(0, 480);
            const extraInfoHtml = expandedExtra?.bodyHtml ? `<div style="margin-bottom:10px">${expandedExtra.bodyHtml}</div>` : '';
            const extraInfoText = expandedExtra?.bodyText ? `${expandedExtra.bodyText}\n\n` : '';
            const fwdBody = `<p><em>Forwarded automatically by rule "${ruleName.replace(/&/g, '&amp;').replace(/</g, '&lt;')}" from ${(msg.fromName || msg.fromAddress).replace(/&/g, '&amp;').replace(/</g, '&lt;')}:</em></p>${extraInfoHtml}<pre>${msg.bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
            db.prepare(
              `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, scheduled_for, version, created_at, updated_at)
               VALUES (?, ?, ?, NULL, ?, 'forward', ?, '[]', '[]', ?, ?, ?, 0, 'scheduled', ?, 1, ?, ?)`
            ).run(
              draftId,
              userId,
              msg.accountId,
              msg.id,
              JSON.stringify([{ name: '', address: targetEmail }]),
              fwdSubject,
              fwdBody,
              `${extraInfoText}${msg.bodyText}`,
              now,
              now,
              now
            );
            const allAssets = Array.from(
              new Set([...(action.attachmentIds || []), ...(expandedExtra?.collectedAssetIds || [])])
            );
            cloneFilesToDraft(db, userId, draftId, {
              assetIds: allAssets,
              sourceMessageId: action.includeOriginalAttachments ? msg.id : undefined,
            });
            executedActions.push('forward');
          } else {
            skippedGuardCount += 1;
            if (ruleId) {
              recordRuleExecutionLog(db, {
                ruleId,
                userId,
                messageId: msg.id,
                threadId: msg.threadId,
                status: 'skipped_guard',
                detail: skipReason
                  ? `Auto-forward skipped (${skipReason})`
                  : 'Auto-forward skipped due to invalid target, self-loop, or rate limit',
              });
            }
          }
          break;
        }
      }
    }

    if (ruleId && executedActions.length > 0) {
      recordRuleExecutionLog(db, {
        ruleId,
        userId,
        messageId: msg.id,
        threadId: msg.threadId,
        status: 'executed',
        detail: `Applied ${executedActions.join(', ')}`,
      });
    }
  } catch (err) {
    if (ruleId) {
      recordRuleExecutionLog(db, {
        ruleId,
        userId,
        messageId: msg.id,
        threadId: msg.threadId,
        status: 'failed',
        detail: err instanceof Error ? err.message : 'Rule execution error',
      });
    }
  }

  return {
    notify,
    movedToFolderId,
    skippedByGuard: executedActions.length === 0 && skippedGuardCount > 0,
    createdTask,
    createdEvent,
  };
}

export function previewRuleMatches(
  db: DatabaseSync,
  userId: string,
  accountId: string | null,
  matchMode: 'all' | 'any',
  conditions: RuleCondition[]
): Array<{ id: string; threadId: string; subject: string; fromName: string; fromAddress: string; receivedAt: string }> {
  const rows = db
    .prepare(
      `SELECT id, account_id, thread_id, from_name, from_address, to_json, cc_json, subject, body_text, has_attachments, received_at, category_slug, is_read, is_starred, is_important
       FROM messages
       WHERE user_id = ? AND is_draft = 0 AND (? IS NULL OR account_id = ?)
       ORDER BY received_at DESC
       LIMIT 250`
    )
    .all(userId, accountId, accountId) as Array<{
    id: string;
    account_id: string;
    thread_id: string;
    from_name: string;
    from_address: string;
    to_json: string;
    cc_json: string;
    subject: string;
    body_text: string;
    has_attachments: number;
    received_at: string;
    category_slug: string;
    is_read: number;
    is_starred: number;
    is_important: number;
  }>;

  const labelStmt = db.prepare('SELECT label_id FROM message_labels WHERE message_id = ?');
  const matches: Array<{
    id: string;
    threadId: string;
    subject: string;
    fromName: string;
    fromAddress: string;
    receivedAt: string;
  }> = [];

  for (const row of rows) {
    const labelRows = labelStmt.all(row.id) as Array<{ label_id: string }>;
    const msg: EvaluableMessage = {
      id: row.id,
      accountId: row.account_id,
      threadId: row.thread_id,
      fromName: row.from_name,
      fromAddress: row.from_address,
      to: JSON.parse(row.to_json) as EmailParticipant[],
      cc: JSON.parse(row.cc_json) as EmailParticipant[],
      subject: row.subject,
      bodyText: row.body_text,
      hasAttachments: Boolean(row.has_attachments),
      receivedAt: row.received_at,
      labelIds: labelRows.map((l) => l.label_id),
      categorySlug: row.category_slug,
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      isImportant: Boolean(row.is_important),
    };
    if (doesRuleMatch(matchMode, conditions, msg)) {
      matches.push({
        id: row.id,
        threadId: row.thread_id,
        subject: row.subject,
        fromName: row.from_name,
        fromAddress: row.from_address,
        receivedAt: row.received_at,
      });
    }
  }
  return matches;
}
