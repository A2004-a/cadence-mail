import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '../types.js';
import { eventBus } from './eventBus.js';

function deepMergePrefs(base: UserPreferences, patch: Partial<UserPreferences>): UserPreferences {
  const merged: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
      merged[k] = { ...merged[k], ...v };
    } else if (v !== undefined) {
      merged[k] = v;
    }
  }
  return merged as UserPreferences;
}

export function loadUserPreferences(db: DatabaseSync, userId: string): UserPreferences {
  const row = db.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?').get(userId) as
    | { preferences_json: string }
    | undefined;
  if (!row) return DEFAULT_USER_PREFERENCES;
  try {
    return deepMergePrefs(DEFAULT_USER_PREFERENCES, JSON.parse(row.preferences_json) as Partial<UserPreferences>);
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

function parseMinutes(hhmm: string): number {
  const [hStr, mStr] = (hhmm || '').split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
}

export function isWithinQuietHours(prefs: UserPreferences, now = new Date()): boolean {
  if (!prefs.notifications.quietHoursEnabled) return false;
  const startMin = parseMinutes(prefs.notifications.quietHoursStart);
  const endMin = parseMinutes(prefs.notifications.quietHoursEnd);
  if (startMin === endMin) return false;

  let currentMin = now.getHours() * 60 + now.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: prefs.general.timezone || 'UTC',
    }).formatToParts(now);
    const hourPart = Number(parts.find((p) => p.type === 'hour')?.value);
    const minPart = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(hourPart) && Number.isFinite(minPart)) {
      currentMin = (hourPart % 24) * 60 + minPart;
    }
  } catch {
    // fallback to server local clock if user supplied non-IANA zone
  }

  if (startMin < endMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  return currentMin >= startMin || currentMin < endMin;
}

export function createUserNotification(
  db: DatabaseSync,
  params: {
    userId: string;
    accountId: string | null;
    threadId: string | null;
    messageId: string | null;
    type: 'new_mail' | 'rule_match' | 'snooze_wake' | 'reminder' | 'sync_error' | 'automation_sent';
    title: string;
    body: string;
    categorySlug?: string;
    isImportant?: boolean;
  }
): { created: boolean; suppressedByQuietHours: boolean } {
  const prefs = loadUserPreferences(db, params.userId);
  if (!prefs.notifications.enabled && params.type !== 'sync_error') {
    return { created: false, suppressedByQuietHours: false };
  }
  if (params.type === 'new_mail') {
    if (prefs.notifications.importantOnly && !params.isImportant) {
      return { created: false, suppressedByQuietHours: false };
    }
    if (
      params.categorySlug &&
      prefs.notifications.categories.length > 0 &&
      !prefs.notifications.categories.includes(params.categorySlug) &&
      !params.isImportant
    ) {
      return { created: false, suppressedByQuietHours: false };
    }
  }

  const quiet = isWithinQuietHours(prefs) && params.type !== 'sync_error';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const shownBody = prefs.notifications.showPreview ? params.body : 'New activity (preview hidden by privacy settings)';

  db.prepare(
    `INSERT INTO notifications (id, user_id, account_id, thread_id, message_id, type, title, body, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id,
    params.userId,
    params.accountId,
    params.threadId,
    params.messageId,
    params.type,
    params.title,
    shownBody,
    now
  );

  if (!quiet) {
    eventBus.emit(params.userId, 'notification', {
      id,
      type: params.type,
      title: params.title,
      body: shownBody,
      threadId: params.threadId,
      soundEnabled: prefs.notifications.soundEnabled,
      desktopEnabled: prefs.notifications.desktopNotifications,
    });
  }

  return { created: true, suppressedByQuietHours: quiet };
}
