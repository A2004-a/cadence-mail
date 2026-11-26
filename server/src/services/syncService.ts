import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { ProviderCredentials } from '../providers/types.js';
import { decryptSecret, encryptSecret } from '../security/crypto.js';
import type { ProviderType } from '../types.js';
import { eventBus } from './eventBus.js';
import { createUserNotification } from './notificationService.js';
import { ingestMessage, recomputeThreadState } from './threadService.js';

const syncBackoffMap = new Map<string, { failures: number; nextAllowedAt: number }>();

export function clearSyncBackoff(accountId: string): void {
  syncBackoffMap.delete(accountId);
}

export async function syncAccount(
  accountId: string,
  userId: string,
  db: DatabaseSync = getDb()
): Promise<{ ok: boolean; added: number; updated: number; error?: string }> {
  const account = db
    .prepare(
      'SELECT id, user_id, provider_type, email_address, encrypted_credentials, sync_cursor, status FROM accounts WHERE id = ? AND user_id = ?'
    )
    .get(accountId, userId) as
    | {
        id: string;
        user_id: string;
        provider_type: ProviderType;
        email_address: string;
        encrypted_credentials: string;
        sync_cursor: string;
        status: string;
      }
    | undefined;

  if (!account) {
    return { ok: false, added: 0, updated: 0, error: 'Account not found' };
  }

  if (account.status === 'disconnected') {
    return { ok: false, added: 0, updated: 0, error: 'Account is disconnected' };
  }

  const startedAt = Date.now();
  db.prepare("UPDATE accounts SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    accountId
  );
  eventBus.emit(userId, 'sync_started', { accountId });

  try {
    const credentials: ProviderCredentials =
      account.provider_type === 'local'
        ? { type: 'local' }
        : (JSON.parse(decryptSecret(account.encrypted_credentials)) as ProviderCredentials);

    const adapter = getProviderAdapter(account.provider_type);

    // Sync folders if supported
    if (adapter.capabilities.supportsFolders && account.provider_type !== 'local') {
      const remoteFolders = await adapter.fetchFolders(credentials);
      const now = new Date().toISOString();
      const folderStmt = db.prepare(
        `INSERT OR IGNORE INTO folders (id, account_id, user_id, remote_id, name, slug, system_role, color, sort_order, is_favorite, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '#64748B', 10, 0, ?)`
      );
      for (const rf of remoteFolders) {
        folderStmt.run(crypto.randomUUID(), accountId, userId, rf.remoteId, rf.name, rf.slug, rf.systemRole, now);
      }
    }

    // Sync labels if supported
    if (adapter.capabilities.supportsLabels && account.provider_type !== 'local') {
      const remoteLabels = await adapter.fetchLabels(credentials);
      const now = new Date().toISOString();
      for (const rl of remoteLabels) {
        const exists = db
          .prepare('SELECT id FROM labels WHERE user_id = ? AND account_id = ? AND remote_id = ?')
          .get(userId, accountId, rl.remoteId);
        if (!exists) {
          db.prepare(
            'INSERT INTO labels (id, user_id, account_id, remote_id, name, color, sort_order, is_favorite, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)'
          ).run(crypto.randomUUID(), userId, accountId, rl.remoteId, rl.name, rl.color || '#2563EB', now);
        }
      }
    }

    const result = await adapter.syncChanges(credentials, account.sync_cursor);

    if (result.refreshedCredentials) {
      db.prepare('UPDATE accounts SET encrypted_credentials = ?, updated_at = ? WHERE id = ?').run(
        encryptSecret(JSON.stringify(result.refreshedCredentials)),
        new Date().toISOString(),
        accountId
      );
    }

    if (result.expiredAuth) {
      db.prepare("UPDATE accounts SET status = 'auth_expired', last_error = ?, updated_at = ? WHERE id = ?").run(
        result.error || 'Authentication expired',
        new Date().toISOString(),
        accountId
      );
      db.prepare(
        'INSERT INTO sync_logs (id, account_id, user_id, status, messages_added, messages_updated, duration_ms, error_message, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)'
      ).run(
        crypto.randomUUID(),
        accountId,
        userId,
        'auth_expired',
        Date.now() - startedAt,
        result.error || 'Authentication expired',
        new Date().toISOString()
      );
      syncBackoffMap.set(accountId, { failures: 99, nextAllowedAt: Date.now() + 3600_000 });
      createUserNotification(db, {
        userId,
        accountId,
        threadId: null,
        messageId: null,
        type: 'sync_error',
        title: `Reconnect ${account.email_address}`,
        body: result.error || 'Account authorization expired. Reconnect in Settings -> Accounts.',
      });
      eventBus.emit(userId, 'sync_error', { accountId, status: 'auth_expired', error: result.error });
      return { ok: false, added: 0, updated: 0, error: result.error || 'Authentication expired' };
    }

    if (result.error) {
      throw new Error(result.error);
    }

    let addedCount = 0;
    for (const payload of result.added) {
      const res = ingestMessage(db, userId, accountId, payload);
      if (res.inserted) addedCount += 1;
    }

    let updatedCount = 0;
    for (const upd of result.updated) {
      const row = db
        .prepare('SELECT id, thread_id FROM messages WHERE account_id = ? AND remote_id = ? LIMIT 1')
        .get(accountId, upd.remoteId) as { id: string; thread_id: string } | undefined;
      if (!row) continue;
      if (upd.isRead !== undefined) {
        db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(upd.isRead ? 1 : 0, row.id);
      }
      if (upd.isStarred !== undefined) {
        db.prepare('UPDATE messages SET is_starred = ? WHERE id = ?').run(upd.isStarred ? 1 : 0, row.id);
      }
      if (upd.isImportant !== undefined) {
        db.prepare('UPDATE messages SET is_important = ? WHERE id = ?').run(upd.isImportant ? 1 : 0, row.id);
      }
      if (upd.isSpam !== undefined) {
        db.prepare('UPDATE messages SET is_spam = ? WHERE id = ?').run(upd.isSpam ? 1 : 0, row.id);
      }
      if (upd.isTrash !== undefined) {
        db.prepare('UPDATE messages SET is_trash = ? WHERE id = ?').run(upd.isTrash ? 1 : 0, row.id);
      }
      if (upd.isArchived !== undefined) {
        db.prepare('UPDATE messages SET is_archived = ? WHERE id = ?').run(upd.isArchived ? 1 : 0, row.id);
      }
      recomputeThreadState(db, row.thread_id);
      updatedCount += 1;
    }

    // Sync contacts opportunistically if provider supports Contacts API
    if (adapter.capabilities.supportsContactsSync && adapter.fetchContacts && account.provider_type !== 'local' && account.provider_type !== 'hosted') {
      try {
        const remoteContacts = await adapter.fetchContacts(credentials);
        const cNow = new Date().toISOString();
        for (const rc of remoteContacts) {
          const existingContact = db
            .prepare('SELECT id, source FROM contacts WHERE user_id = ? AND lower(email) = lower(?)')
            .get(userId, rc.email) as { id: string; source: string } | undefined;
          if (!existingContact) {
            db.prepare(
              `INSERT INTO contacts (id, user_id, account_id, remote_id, source, name, email, organization, phone, notes, avatar_color, is_favorite, contact_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'provider_synced', ?, ?, ?, ?, '', '#0284C7', 0, 0, ?, ?)`
            ).run(crypto.randomUUID(), userId, accountId, rc.remoteId, rc.name, rc.email.toLowerCase(), rc.organization || '', rc.phone || '', cNow, cNow);
          } else if (existingContact.source === 'provider_synced') {
            db.prepare(
              'UPDATE contacts SET name = ?, organization = ?, phone = ?, account_id = ?, remote_id = ?, updated_at = ? WHERE id = ?'
            ).run(rc.name, rc.organization || '', rc.phone || '', accountId, rc.remoteId, cNow, existingContact.id);
          }
        }
      } catch {
        // Non-fatal optional contacts sync
      }
    }

    syncBackoffMap.delete(accountId);
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE accounts SET status = 'connected', sync_cursor = ?, last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?"
    ).run(result.nextCursor, now, now, accountId);

    db.prepare(
      'INSERT INTO sync_logs (id, account_id, user_id, status, messages_added, messages_updated, duration_ms, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'
    ).run(crypto.randomUUID(), accountId, userId, 'ok', addedCount, updatedCount, Date.now() - startedAt, now);

    eventBus.emit(userId, 'sync_completed', {
      accountId,
      added: addedCount,
      updated: updatedCount,
      lastSyncedAt: now,
    });

    return { ok: true, added: addedCount, updated: updatedCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Synchronization failed';
    const prev = syncBackoffMap.get(accountId) || { failures: 0, nextAllowedAt: 0 };
    const failures = prev.failures + 1;
    const waitMs = Math.min(30 * 60_000, 60_000 * Math.pow(2, failures - 1));
    syncBackoffMap.set(accountId, { failures, nextAllowedAt: Date.now() + waitMs });
    const now = new Date().toISOString();
    db.prepare("UPDATE accounts SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(
      errMsg,
      now,
      accountId
    );
    db.prepare(
      'INSERT INTO sync_logs (id, account_id, user_id, status, messages_added, messages_updated, duration_ms, error_message, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)'
    ).run(crypto.randomUUID(), accountId, userId, 'error', Date.now() - startedAt, errMsg, now);

    eventBus.emit(userId, 'sync_error', { accountId, status: 'error', error: errMsg });
    return { ok: false, added: 0, updated: 0, error: errMsg };
  }
}

export async function syncConnectedAccountsWithBackoff(db: DatabaseSync = getDb()): Promise<void> {
  const remoteAccounts = db
    .prepare("SELECT id, user_id FROM accounts WHERE provider_type != 'local' AND status IN ('connected', 'error')")
    .all() as Array<{ id: string; user_id: string }>;
  const now = Date.now();
  for (const acc of remoteAccounts) {
    const backoff = syncBackoffMap.get(acc.id);
    if (backoff && backoff.nextAllowedAt > now) continue;
    await syncAccount(acc.id, acc.user_id, db);
  }
}
