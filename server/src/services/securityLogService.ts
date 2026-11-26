import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.js';

export function recordSecurityEvent(
  params: {
    userId?: string | null;
    eventType: string;
    severity?: 'info' | 'warning' | 'high';
    actorEmail?: string;
    ipAddress?: string;
    details?: Record<string, unknown>;
  },
  db: DatabaseSync = getDb()
): void {
  try {
    db.prepare(
      `INSERT INTO security_events (id, user_id, event_type, severity, actor_email, ip_address, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      params.userId ?? null,
      params.eventType,
      params.severity || 'info',
      params.actorEmail || '',
      params.ipAddress || '',
      JSON.stringify(params.details || {}),
      new Date().toISOString()
    );
  } catch {
    // Non-fatal audit logging failure should not break request path
  }
}
