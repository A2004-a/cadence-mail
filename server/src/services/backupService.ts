import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ATTACHMENTS_DIR, BACKUPS_DIR } from '../config.js';
import { getDb } from '../db/database.js';
import { sha256Hex } from '../security/crypto.js';
import { recordSecurityEvent } from './securityLogService.js';

export interface BackupManifest {
  backupId: string;
  createdAt: string;
  includeAttachments: boolean;
  dbSizeBytes: number;
  attachmentsCount: number;
  attachmentsBytes: number;
  counts: {
    users: number;
    domains: number;
    accounts: number;
    threads: number;
    messages: number;
  };
  secretsSanitized: string[];
}

function getDirStats(dirPath: string): { bytes: number; files: number } {
  if (!fs.existsSync(dirPath)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = getDirStats(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += fs.statSync(full).size;
      files += 1;
    }
  }
  return { bytes, files };
}

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function createInfrastructureBackup(
  db: DatabaseSync = getDb(),
  createdByUserId: string | null = null,
  opts: { includeAttachments?: boolean; retentionKeep?: number } = {}
) {
  const backupId = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUPS_DIR, `${stamp}_${backupId.slice(0, 8)}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const snapshotDbPath = path.join(backupDir, 'cadence-snapshot.db');
  const escapedPath = snapshotDbPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}';`);

  // Strip ephemeral session tokens & third-party external credentials from portable backup snapshot
  const snapDb = new DatabaseSync(snapshotDbPath);
  let counts = { users: 0, domains: 0, accounts: 0, threads: 0, messages: 0 };
  try {
    snapDb.exec(`
      DELETE FROM sessions;
      DELETE FROM oauth_states;
      UPDATE accounts SET encrypted_credentials = '__STRIPPED_IN_BACKUP__' WHERE account_ownership = 'external';
      UPDATE domains SET dkim_private_key_enc = '';
    `);
    counts = {
      users: (snapDb.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c,
      domains: (snapDb.prepare('SELECT COUNT(*) AS c FROM domains').get() as { c: number }).c,
      accounts: (snapDb.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c,
      threads: (snapDb.prepare('SELECT COUNT(*) AS c FROM threads').get() as { c: number }).c,
      messages: (snapDb.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c,
    };
  } finally {
    snapDb.close();
  }

  const includeAttachments = opts.includeAttachments !== false;
  let attStats = { bytes: 0, files: 0 };
  if (includeAttachments && fs.existsSync(ATTACHMENTS_DIR)) {
    const destAtt = path.join(backupDir, 'attachments');
    copyDirRecursive(ATTACHMENTS_DIR, destAtt);
    attStats = getDirStats(destAtt);
  }

  const dbBuf = fs.readFileSync(snapshotDbPath);
  const checksum = sha256Hex(dbBuf);
  const createdAt = new Date().toISOString();

  const manifest: BackupManifest = {
    backupId,
    createdAt,
    includeAttachments,
    dbSizeBytes: dbBuf.byteLength,
    attachmentsCount: attStats.files,
    attachmentsBytes: attStats.bytes,
    counts,
    secretsSanitized: ['sessions', 'oauth_states', 'external_account_credentials', 'dkim_private_keys'],
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const totalStats = getDirStats(backupDir);
  db.prepare(
    `INSERT INTO backup_records (id, created_by_user_id, backup_path, size_bytes, include_attachments, status, checksum_sha256, manifest_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
  ).run(
    backupId,
    createdByUserId,
    backupDir,
    totalStats.bytes,
    includeAttachments ? 1 : 0,
    checksum,
    JSON.stringify(manifest),
    createdAt
  );

  // Retention cleanup (keep newest N backups)
  const keepCount = Math.max(2, opts.retentionKeep ?? 10);
  const oldRows = db
    .prepare('SELECT id, backup_path FROM backup_records ORDER BY created_at DESC LIMIT -1 OFFSET ?')
    .all(keepCount) as Array<{ id: string; backup_path: string }>;
  for (const old of oldRows) {
    try {
      if (fs.existsSync(old.backup_path)) {
        fs.rmSync(old.backup_path, { recursive: true, force: true });
      }
      db.prepare('DELETE FROM backup_records WHERE id = ?').run(old.id);
    } catch {
      // ignore retention cleanup error
    }
  }

  recordSecurityEvent({
    userId: createdByUserId,
    eventType: 'backup_created',
    severity: 'info',
    details: { backupId, sizeBytes: totalStats.bytes, includeAttachments },
  }, db);

  return {
    id: backupId,
    backupPath: backupDir,
    sizeBytes: totalStats.bytes,
    checksumSha256: checksum,
    manifest,
    createdAt,
  };
}

export function verifyBackupIntegrity(db: DatabaseSync, backupId: string) {
  const row = db.prepare('SELECT * FROM backup_records WHERE id = ?').get(backupId) as Record<string, any> | undefined;
  if (!row) throw new Error('Backup record not found');

  const snapshotDbPath = path.join(row.backup_path, 'cadence-snapshot.db');
  if (!fs.existsSync(snapshotDbPath)) {
    throw new Error('Snapshot database file missing on disk');
  }

  const checksum = sha256Hex(fs.readFileSync(snapshotDbPath));
  const checksumMatch = checksum === row.checksum_sha256;

  const snapDb = new DatabaseSync(snapshotDbPath, { readOnly: true });
  let integrityResult = 'failed';
  let counts = { users: 0, domains: 0, accounts: 0, threads: 0, messages: 0 };
  try {
    const check = snapDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    integrityResult = check.integrity_check;
    counts = {
      users: (snapDb.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c,
      domains: (snapDb.prepare('SELECT COUNT(*) AS c FROM domains').get() as { c: number }).c,
      accounts: (snapDb.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c,
      threads: (snapDb.prepare('SELECT COUNT(*) AS c FROM threads').get() as { c: number }).c,
      messages: (snapDb.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c,
    };
  } finally {
    snapDb.close();
  }

  return {
    ok: checksumMatch && integrityResult === 'ok',
    checksumMatch,
    integrityResult,
    counts,
    backupPath: row.backup_path,
  };
}

export function restoreBackup(
  db: DatabaseSync,
  backupId: string,
  actorUserId: string,
  opts: { dryRun?: boolean } = {}
) {
  const check = verifyBackupIntegrity(db, backupId);
  if (!check.ok) {
    throw new Error(`Backup verification failed (checksumMatch=${check.checksumMatch}, sqlite=${check.integrityResult})`);
  }

  const row = db.prepare('SELECT * FROM backup_records WHERE id = ?').get(backupId) as Record<string, any>;
  if (opts.dryRun) {
    return { ok: true, dryRun: true, verified: check };
  }

  const snapshotDbPath = path.join(row.backup_path, 'cadence-snapshot.db');
  const escaped = snapshotDbPath.replace(/'/g, "''");

  // Restore independent infrastructure & mailbox entities safely without deleting current admin session
  db.exec(`ATTACH DATABASE '${escaped}' AS bak;`);
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`
      BEGIN;
      INSERT OR IGNORE INTO users SELECT * FROM bak.users;
      INSERT OR IGNORE INTO domains SELECT * FROM bak.domains;
      INSERT OR IGNORE INTO accounts SELECT * FROM bak.accounts;
      INSERT OR IGNORE INTO mailbox_aliases SELECT * FROM bak.mailbox_aliases;
      INSERT OR IGNORE INTO folders SELECT * FROM bak.folders;
      INSERT OR IGNORE INTO labels SELECT * FROM bak.labels;
      INSERT OR IGNORE INTO threads SELECT * FROM bak.threads;
      INSERT OR IGNORE INTO messages SELECT * FROM bak.messages;
      INSERT OR IGNORE INTO attachments SELECT * FROM bak.attachments;
      INSERT OR IGNORE INTO contacts SELECT * FROM bak.contacts;
      INSERT OR IGNORE INTO rules SELECT * FROM bak.rules;
      INSERT OR IGNORE INTO templates SELECT * FROM bak.templates;
      INSERT OR IGNORE INTO reminders SELECT * FROM bak.reminders;
      COMMIT;
    `);
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('DETACH DATABASE bak;');
  }

  const attSrc = path.join(row.backup_path, 'attachments');
  if (fs.existsSync(attSrc)) {
    copyDirRecursive(attSrc, ATTACHMENTS_DIR);
  }

  db.prepare("UPDATE backup_records SET status = 'restored' WHERE id = ?").run(backupId);
  recordSecurityEvent(
    {
      userId: actorUserId,
      eventType: 'backup_restored',
      severity: 'high',
      details: { backupId, counts: check.counts },
    },
    db
  );

  return { ok: true, dryRun: false, restored: check.counts };
}
