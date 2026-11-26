import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { EmailParticipant } from '../types.js';
import { eventBus } from './eventBus.js';
import { createUserNotification } from './notificationService.js';
import { storeAttachmentBuffer } from './threadService.js';

export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'interval_hours';

export interface InfoProfileRow {
  id: string;
  user_id: string;
  slug: string;
  kind: 'location' | 'contact' | 'document' | 'custom';
  title: string;
  content_text: string;
  map_query: string;
  map_url: string;
  attachment_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduledAutomationRow {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  enabled: number;
  frequency: ScheduleFrequency;
  time_of_day: string;
  timezone: string;
  days_of_week_json: string;
  day_of_month: number;
  interval_hours: number;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_text: string;
  body_html: string;
  info_profile_ids_json: string;
  attachment_ids_json: string;
  max_runs: number | null;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type DraftDispatcher = (
  db: DatabaseSync,
  draftId: string
) => Promise<{ ok: boolean; error?: string; messageId?: string; threadId?: string }>;

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeGoogleMapsUrl(mapQuery: string, explicitUrl?: string): string {
  const cleanExplicit = (explicitUrl || '').trim();
  if (cleanExplicit) {
    try {
      const parsed = new URL(cleanExplicit);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.toString();
      }
    } catch {
      // fall through to mapQuery
    }
  }
  const q = mapQuery.trim();
  if (!q) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function getZonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: WEEKDAY_MAP[map.weekday] ?? 0,
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
  };
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  let candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 2; i++) {
    const zp = getZonedParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(zp.year, zp.month - 1, zp.day, zp.hour, zp.minute, 0, 0);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = actualAsUtc - desiredAsUtc;
    if (delta === 0) break;
    candidate -= delta;
  }
  return candidate;
}

/** Computes the next strictly-future ISO execution timestamp in the schedule's configured timezone. */
export function computeNextRunAt(
  schedule: {
    frequency: ScheduleFrequency;
    timeOfDay: string;
    timezone: string;
    daysOfWeek?: number[];
    dayOfMonth?: number;
    intervalHours?: number;
  },
  fromDate: Date = new Date()
): string {
  if (schedule.frequency === 'interval_hours') {
    const hours = Math.max(1, Math.min(168, schedule.intervalHours || 24));
    return new Date(fromDate.getTime() + hours * 3600_000).toISOString();
  }

  const tz = isValidTimeZone(schedule.timezone) ? schedule.timezone : 'UTC';
  const [hStr, mStr] = (schedule.timeOfDay || '05:00').split(':');
  const targetHour = Math.max(0, Math.min(23, Number(hStr) || 0));
  const targetMin = Math.max(0, Math.min(59, Number(mStr) || 0));
  const nowParts = getZonedParts(fromDate, tz);
  const allowedWeekdays = new Set(
    schedule.frequency === 'weekdays'
      ? [1, 2, 3, 4, 5]
      : schedule.daysOfWeek && schedule.daysOfWeek.length > 0
      ? schedule.daysOfWeek
      : [0, 1, 2, 3, 4, 5, 6]
  );
  const targetDom = Math.max(1, Math.min(28, schedule.dayOfMonth || 1));

  for (let offsetDays = 0; offsetDays <= 70; offsetDays++) {
    const ref = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + offsetDays, 12, 0, 0));
    const y = ref.getUTCFullYear();
    const m = ref.getUTCMonth() + 1;
    const d = ref.getUTCDate();
    const utcMs = zonedWallTimeToUtc(y, m, d, targetHour, targetMin, tz);
    if (utcMs <= fromDate.getTime()) continue;

    const zp = getZonedParts(new Date(utcMs), tz);
    if (schedule.frequency === 'weekdays' || schedule.frequency === 'weekly') {
      if (!allowedWeekdays.has(zp.weekday)) continue;
    } else if (schedule.frequency === 'monthly') {
      if (zp.day !== targetDom) continue;
    }
    return new Date(utcMs).toISOString();
  }

  return new Date(fromDate.getTime() + 86_400_000).toISOString();
}

export function formatInfoProfileText(profile: InfoProfileRow): string {
  const effectiveMapUrl = normalizeGoogleMapsUrl(profile.map_query, profile.map_url);
  const lines: string[] = [profile.title];
  if (profile.map_query.trim()) lines.push(`Address / Location: ${profile.map_query.trim()}`);
  if (effectiveMapUrl) lines.push(`Google Maps: ${effectiveMapUrl}`);
  if (profile.content_text.trim()) lines.push(profile.content_text.trim());
  return lines.join('\n');
}

/** Escapes text safely for HTML email while converting HTTP(S) URLs to clickable links. */
export function renderAutomationTextToHtml(plainText: string): string {
  const paragraphs = plainText.split(/\r?\n\r?\n/);
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;

  const formatLine = (line: string): string => {
    let out = '';
    let lastIdx = 0;
    for (const match of line.matchAll(urlRegex)) {
      const idx = match.index ?? 0;
      const before = line.slice(lastIdx, idx);
      out += before.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const rawUrl = match[0];
      const safeUrl = rawUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      out += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
      lastIdx = idx + rawUrl.length;
    }
    out += line
      .slice(lastIdx)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return out;
  };

  return paragraphs
    .map((p) => `<p>${p.split(/\r?\n/).map(formatLine).join('<br>')}</p>`)
    .join('');
}

export function expandAutomationMessage(
  db: DatabaseSync,
  userId: string,
  rawSubject: string,
  rawBody: string,
  opts?: {
    account?: { displayName?: string; emailAddress?: string };
    msg?: { fromName?: string; fromAddress?: string; subject?: string };
    extraInfoProfileIds?: string[];
    timezone?: string;
  }
): { subject: string; bodyText: string; bodyHtml: string; collectedAssetIds: string[] } {
  const profiles = db
    .prepare('SELECT * FROM automation_info_profiles WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as unknown as InfoProfileRow[];

  const bySlug = new Map<string, InfoProfileRow>();
  const byId = new Map<string, InfoProfileRow>();
  let primaryLocation: InfoProfileRow | undefined;
  let primaryContact: InfoProfileRow | undefined;
  for (const p of profiles) {
    bySlug.set(p.slug.toLowerCase(), p);
    byId.set(p.id, p);
    if (!primaryLocation && p.kind === 'location') primaryLocation = p;
    if (!primaryContact && p.kind === 'contact') primaryContact = p;
  }

  const now = new Date();
  const tz = opts?.timezone && isValidTimeZone(opts.timezone) ? opts.timezone : 'UTC';
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const timeStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(now);

  const collectedAssets = new Set<string>();
  const markProfileUsed = (p?: InfoProfileRow) => {
    if (!p) return '';
    try {
      const ids = JSON.parse(p.attachment_ids_json || '[]') as string[];
      for (const id of ids) collectedAssets.add(id);
    } catch {
      // ignore
    }
    return formatInfoProfileText(p);
  };

  const mapLocText = primaryLocation
    ? markProfileUsed(primaryLocation)
    : 'Location details have not been configured yet in Automations -> Shared Info Vault.';
  const mapUrlOnly = primaryLocation ? normalizeGoogleMapsUrl(primaryLocation.map_query, primaryLocation.map_url) : '';
  const contactText = primaryContact ? markProfileUsed(primaryContact) : '';

  const applyVars = (input: string, collectInfoAttachments: boolean): string => {
    let out = input
      .replace(/\{\{\s*date\s*\}\}/gi, dateStr)
      .replace(/\{\{\s*day\s*\}\}/gi, dayStr)
      .replace(/\{\{\s*time\s*\}\}/gi, timeStr)
      .replace(/\{\{\s*from_name\s*\}\}/gi, opts?.msg?.fromName || opts?.msg?.fromAddress || 'there')
      .replace(/\{\{\s*from_email\s*\}\}/gi, opts?.msg?.fromAddress || '')
      .replace(/\{\{\s*subject\s*\}\}/gi, opts?.msg?.subject || '')
      .replace(/\{\{\s*my_name\s*\}\}/gi, opts?.account?.displayName || '')
      .replace(/\{\{\s*my_email\s*\}\}/gi, opts?.account?.emailAddress || '');

    out = out.replace(/\{\{\s*(?:google_map_location|location)\s*\}\}/gi, () => {
      if (collectInfoAttachments) return mapLocText;
      return primaryLocation?.title || 'Location';
    });
    out = out.replace(/\{\{\s*(?:google_map_url|map_url)\s*\}\}/gi, () => mapUrlOnly);
    out = out.replace(/\{\{\s*contact_info\s*\}\}/gi, () => (collectInfoAttachments ? contactText : primaryContact?.title || ''));

    out = out.replace(/\{\{\s*info:([a-zA-Z0-9_-]+)\s*\}\}/gi, (_, slug: string) => {
      const match = bySlug.get(slug.toLowerCase());
      if (!match) return '';
      return collectInfoAttachments ? markProfileUsed(match) : match.title;
    });
    return out;
  };

  const subject = applyVars(rawSubject, false).trim();
  let bodyText = applyVars(rawBody, true);

  const extraBlocks: string[] = [];
  for (const pid of opts?.extraInfoProfileIds || []) {
    const prof = byId.get(pid);
    if (!prof) continue;
    const formatted = markProfileUsed(prof);
    const mapUrl = normalizeGoogleMapsUrl(prof.map_query, prof.map_url);
    const alreadyInBody =
      (mapUrl && bodyText.includes(mapUrl)) ||
      (formatted && bodyText.includes(formatted));
    if (!alreadyInBody) {
      extraBlocks.push(formatted);
    }
  }
  if (extraBlocks.length > 0) {
    bodyText = `${bodyText.trim()}\n\n${extraBlocks.join('\n\n')}`.trim();
  }

  return {
    subject: subject || '(no subject)',
    bodyText,
    bodyHtml: renderAutomationTextToHtml(bodyText),
    collectedAssetIds: Array.from(collectedAssets),
  };
}

/** Clones automation vault assets and optional source message attachments into independent draft attachments. */
export function cloneFilesToDraft(
  db: DatabaseSync,
  userId: string,
  draftId: string,
  opts?: { assetIds?: string[]; sourceMessageId?: string }
): number {
  let attachedCount = 0;
  const now = new Date().toISOString();
  const insertStmt = db.prepare(
    `INSERT INTO attachments (id, message_id, draft_id, user_id, filename, mime_type, size_bytes, content_id, is_inline, storage_path, sha256, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)`
  );

  const uniqueAssetIds = Array.from(new Set(opts?.assetIds || []));
  for (const assetId of uniqueAssetIds) {
    const asset = db
      .prepare('SELECT id, filename, mime_type, storage_path FROM automation_assets WHERE id = ? AND user_id = ?')
      .get(assetId, userId) as { id: string; filename: string; mime_type: string; storage_path: string } | undefined;
    if (!asset || !asset.storage_path || !fs.existsSync(asset.storage_path)) continue;
    const buf = fs.readFileSync(asset.storage_path);
    const stored = storeAttachmentBuffer(userId, asset.filename, asset.mime_type, buf, { draftId });
    insertStmt.run(stored.id, draftId, userId, asset.filename, asset.mime_type, stored.sizeBytes, stored.storagePath, stored.sha256, now);
    attachedCount += 1;
  }

  if (opts?.sourceMessageId) {
    const srcAtts = db
      .prepare('SELECT filename, mime_type, storage_path FROM attachments WHERE message_id = ? AND user_id = ?')
      .all(opts.sourceMessageId, userId) as Array<{ filename: string; mime_type: string; storage_path: string }>;
    for (const src of srcAtts) {
      if (!src.storage_path || !fs.existsSync(src.storage_path)) continue;
      const buf = fs.readFileSync(src.storage_path);
      const stored = storeAttachmentBuffer(userId, src.filename, src.mime_type, buf, { draftId });
      insertStmt.run(stored.id, draftId, userId, src.filename, src.mime_type, stored.sizeBytes, stored.storagePath, stored.sha256, now);
      attachedCount += 1;
    }
  }

  return attachedCount;
}

export async function executeScheduledAutomationRow(
  db: DatabaseSync,
  row: ScheduledAutomationRow,
  dispatchDraftNow: DraftDispatcher,
  opts?: { manualRun?: boolean }
): Promise<{ ok: boolean; draftId?: string; messageId?: string; attachedFiles: number; error?: string }> {
  const now = new Date().toISOString();
  const account = db
    .prepare('SELECT id, display_name, email_address FROM accounts WHERE id = ? AND user_id = ?')
    .get(row.account_id, row.user_id) as { id: string; display_name: string; email_address: string } | undefined;

  if (!account) {
    const msg = 'Sending account no longer exists.';
    db.prepare('UPDATE scheduled_automations SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
      'failed',
      msg,
      now,
      row.id
    );
    db.prepare(
      "INSERT INTO scheduled_automation_logs (id, automation_id, user_id, draft_id, status, detail, executed_at) VALUES (?, ?, ?, NULL, 'failed', ?, ?)"
    ).run(crypto.randomUUID(), row.id, row.user_id, msg, now);
    return { ok: false, attachedFiles: 0, error: msg };
  }

  const to = JSON.parse(row.to_json || '[]') as EmailParticipant[];
  const cc = JSON.parse(row.cc_json || '[]') as EmailParticipant[];
  const bcc = JSON.parse(row.bcc_json || '[]') as EmailParticipant[];
  const infoProfileIds = JSON.parse(row.info_profile_ids_json || '[]') as string[];
  const assetIds = JSON.parse(row.attachment_ids_json || '[]') as string[];

  const expanded = expandAutomationMessage(db, row.user_id, row.subject, row.body_text, {
    account: { displayName: account.display_name, emailAddress: account.email_address },
    extraInfoProfileIds: infoProfileIds,
    timezone: row.timezone,
  });

  const combinedAssets = Array.from(new Set([...assetIds, ...expanded.collectedAssetIds]));
  const draftId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'new', ?, ?, ?, ?, ?, ?, 0, 'sending', 1, ?, ?)`
  ).run(
    draftId,
    row.user_id,
    row.account_id,
    JSON.stringify(to),
    JSON.stringify(cc),
    JSON.stringify(bcc),
    expanded.subject,
    expanded.bodyHtml,
    expanded.bodyText,
    now,
    now
  );

  const attachedFiles = cloneFilesToDraft(db, row.user_id, draftId, { assetIds: combinedAssets });
  const dispatchRes = await dispatchDraftNow(db, draftId);

  const logStatus = dispatchRes.ok ? 'sent' : 'failed';
  const detail = dispatchRes.ok
    ? `${opts?.manualRun ? 'Manual trigger: sent' : 'Scheduled send'} to ${to.map((r) => r.address).join(', ')} (${attachedFiles} attachment(s))`
    : dispatchRes.error || 'Scheduled dispatch failed';

  db.prepare(
    'UPDATE scheduled_automations SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?'
  ).run(now, logStatus, dispatchRes.ok ? null : detail, now, row.id);

  db.prepare(
    'INSERT INTO scheduled_automation_logs (id, automation_id, user_id, draft_id, status, detail, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), row.id, row.user_id, draftId, logStatus, detail.slice(0, 400), now);

  if (dispatchRes.ok) {
    createUserNotification(db, {
      userId: row.user_id,
      accountId: row.account_id,
      threadId: dispatchRes.threadId || null,
      messageId: dispatchRes.messageId || null,
      type: 'automation_sent',
      title: `Automation sent: ${row.name}`,
      body: detail,
    });
    eventBus.emit(row.user_id, 'automation_executed', { automationId: row.id, name: row.name, status: 'sent' });
  } else {
    eventBus.emit(row.user_id, 'automation_executed', {
      automationId: row.id,
      name: row.name,
      status: 'failed',
      error: detail,
    });
  }

  return {
    ok: dispatchRes.ok,
    draftId,
    messageId: dispatchRes.messageId,
    attachedFiles,
    error: dispatchRes.error,
  };
}

export async function processDueScheduledAutomations(
  db: DatabaseSync,
  dispatchDraftNow: DraftDispatcher
): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dueRows = db
    .prepare("SELECT * FROM scheduled_automations WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20")
    .all(nowIso) as unknown as ScheduledAutomationRow[];

  let executed = 0;
  for (const row of dueRows) {
    if (row.max_runs !== null && row.run_count >= row.max_runs) {
      db.prepare('UPDATE scheduled_automations SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso, row.id);
      continue;
    }

    const daysOfWeek = JSON.parse(row.days_of_week_json || '[0,1,2,3,4,5,6]') as number[];
    const nextRun = computeNextRunAt(
      {
        frequency: row.frequency,
        timeOfDay: row.time_of_day,
        timezone: row.timezone,
        daysOfWeek,
        dayOfMonth: row.day_of_month,
        intervalHours: row.interval_hours,
      },
      now
    );

    const nextCount = row.run_count + 1;
    const stillEnabled = row.max_runs !== null && nextCount >= row.max_runs ? 0 : 1;

    const claimed = db
      .prepare(
        `UPDATE scheduled_automations
         SET next_run_at = ?, run_count = run_count + 1, enabled = ?, updated_at = ?
         WHERE id = ? AND enabled = 1 AND next_run_at = ?`
      )
      .run(nextRun, stillEnabled, nowIso, row.id, row.next_run_at);

    if (claimed.changes === 0) continue;
    await executeScheduledAutomationRow(db, row, dispatchDraftNow, { manualRun: false });
    executed += 1;
  }

  return executed;
}
