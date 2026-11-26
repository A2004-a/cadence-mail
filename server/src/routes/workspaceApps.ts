import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import { decryptSecret } from '../security/crypto.js';
import { sanitizeComposerHtml } from '../security/sanitize.js';
import { eventBus } from '../services/eventBus.js';
import { dispatchDraftNow } from '../services/sendService.js';

export const workspaceAppsRouter = Router();

// =========================
// 1. TASKS MODULE
// =========================
const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).default(''),
  status: z.enum(['todo', 'in_progress', 'completed']).default('todo'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  category: z.string().trim().max(60).default('General'),
  dueAt: z.string().nullable().optional(),
  reminderAt: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  attachmentId: z.string().nullable().optional(),
});

workspaceAppsRouter.get('/tasks', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const view = String(req.query.view || 'all');
  const rows = db
    .prepare(
      `SELECT tk.*, t.subject AS thread_subject, c.name AS contact_name
       FROM tasks tk
       LEFT JOIN threads t ON t.id = tk.thread_id AND t.user_id = tk.user_id
       LEFT JOIN contacts c ON c.id = tk.contact_id AND c.user_id = tk.user_id
       WHERE tk.user_id = ?
       ORDER BY CASE WHEN tk.status = 'completed' THEN 1 ELSE 0 END,
                CASE tk.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                COALESCE(tk.due_at, '9999') ASC`
    )
    .all(userId) as Array<Record<string, any>>;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = todayStart + 86_400_000;

  const formatted = rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      notes: r.notes,
      status: r.status,
      priority: r.priority,
      category: r.category,
      dueAt: r.due_at,
      reminderAt: r.reminder_at,
      threadId: r.thread_id,
      threadSubject: r.thread_subject || null,
      messageId: r.message_id,
      contactId: r.contact_id,
      contactName: r.contact_name || null,
      attachmentId: r.attachment_id,
      completedAt: r.completed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
    .filter((tk) => {
      if (view === 'all') return true;
      if (view === 'completed') return tk.status === 'completed';
      if (tk.status === 'completed') return false;
      const dueMs = tk.dueAt ? new Date(tk.dueAt).getTime() : null;
      if (view === 'overdue') return dueMs !== null && dueMs < now.getTime();
      if (view === 'today') return dueMs !== null && dueMs >= todayStart && dueMs < todayEnd;
      if (view === 'upcoming') return dueMs === null || dueMs >= todayStart;
      return true;
    });

  res.json({ tasks: formatted });
});

workspaceAppsRouter.post('/tasks', requireAuth, (req, res) => {
  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid task title and fields required' });
    return;
  }
  const db = getDb();
  const userId = req.auth!.id;
  const d = parsed.data;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const completedAt = d.status === 'completed' ? now : null;

  db.prepare(
    `INSERT INTO tasks (
      id, user_id, title, notes, status, priority, category, due_at, reminder_at,
      thread_id, message_id, contact_id, attachment_id, assigned_to_user_id, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    d.title,
    d.notes,
    d.status,
    d.priority,
    d.category,
    d.dueAt || null,
    d.reminderAt || null,
    d.threadId || null,
    d.messageId || null,
    d.contactId || null,
    d.attachmentId || null,
    userId,
    completedAt,
    now,
    now
  );

  eventBus.emit(userId, 'task_updated', { taskId: id });
  res.status(201).json({ id });
});

workspaceAppsRouter.patch('/tasks/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as Record<string, any> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const parsed = taskSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task update' });
    return;
  }
  const d = parsed.data;
  const now = new Date().toISOString();
  const nextStatus = d.status ?? existing.status;
  const nextCompletedAt =
    nextStatus === 'completed' ? existing.completed_at || now : d.status ? null : existing.completed_at;

  db.prepare(
    `UPDATE tasks SET title = ?, notes = ?, status = ?, priority = ?, category = ?, due_at = ?, reminder_at = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    d.title ?? existing.title,
    d.notes ?? existing.notes,
    nextStatus,
    d.priority ?? existing.priority,
    d.category ?? existing.category,
    d.dueAt !== undefined ? d.dueAt : existing.due_at,
    d.reminderAt !== undefined ? d.reminderAt : existing.reminder_at,
    nextCompletedAt,
    now,
    existing.id,
    req.auth!.id
  );
  eventBus.emit(req.auth!.id, 'task_updated', { taskId: existing.id });
  res.json({ ok: true });
});

workspaceAppsRouter.delete('/tasks/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  eventBus.emit(req.auth!.id, 'task_updated', { taskId: param(req, 'id') });
  res.json({ ok: true });
});

// =========================
// 2. CALENDAR MODULE
// =========================
const attendeeSchema = z.object({
  name: z.string().default(''),
  address: z.string().trim().email(),
});

const calendarEventSchema = z.object({
  accountId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  location: z.string().max(240).default(''),
  meetingUrl: z.string().max(500).default(''),
  startAt: z.string().min(1),
  endAt: z.string().min(1),
  allDay: z.boolean().default(false),
  timezone: z.string().default('UTC'),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
  attendees: z.array(attendeeSchema).default([]),
  reminderMinutes: z.number().int().min(0).max(10080).default(15),
  source: z.enum(['local', 'extracted', 'ics', 'google', 'outlook']).default('local'),
});

workspaceAppsRouter.get('/calendar/provider-status', requireAuth, (req, res) => {
  const db = getDb();
  const accounts = db
    .prepare("SELECT id, email_address, provider_type, encrypted_credentials FROM accounts WHERE user_id = ? AND provider_type IN ('gmail', 'outlook')")
    .all(req.auth!.id) as Array<{ id: string; email_address: string; provider_type: string; encrypted_credentials: string }>;

  const providers = accounts.map((a) => {
    let scopes: string[] = [];
    if (a.encrypted_credentials) {
      try {
        const creds = JSON.parse(decryptSecret(a.encrypted_credentials)) as { scope?: string };
        if (typeof creds.scope === 'string') scopes = creds.scope.split(/\s+/);
      } catch {
        // ignore
      }
    }
    const hasCalendarScope = scopes.some((s) => /calendar/i.test(s));
    return {
      accountId: a.id,
      emailAddress: a.email_address,
      providerType: a.provider_type,
      externalCalendarSyncEnabled: hasCalendarScope,
      note: hasCalendarScope
        ? 'Calendar OAuth scope detected.'
        : 'Mail-only OAuth scope connected; events remain local with RFC 5545 (.ics) import/export.',
    };
  });

  res.json({ localCalendarReady: true, providers });
});

workspaceAppsRouter.get('/calendar', requireAuth, (req, res) => {
  const db = getDb();
  const start = req.query.start ? String(req.query.start) : null;
  const end = req.query.end ? String(req.query.end) : null;
  let sql = `SELECT ce.*, t.subject AS thread_subject
             FROM calendar_events ce
             LEFT JOIN threads t ON t.id = ce.thread_id AND t.user_id = ce.user_id
             WHERE ce.user_id = ?`;
  const params: string[] = [req.auth!.id];
  if (start && end) {
    sql += ' AND ce.end_at >= ? AND ce.start_at <= ?';
    params.push(start, end);
  }
  sql += ' ORDER BY ce.start_at ASC';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, any>>;
  res.json({
    events: rows.map((e) => ({
      id: e.id,
      accountId: e.account_id,
      threadId: e.thread_id,
      threadSubject: e.thread_subject || null,
      messageId: e.message_id,
      title: e.title,
      description: e.description,
      location: e.location,
      meetingUrl: e.meeting_url,
      startAt: e.start_at,
      endAt: e.end_at,
      allDay: Boolean(e.all_day),
      timezone: e.timezone,
      status: e.status,
      attendees: JSON.parse(e.attendees_json || '[]'),
      reminderMinutes: e.reminder_minutes,
      source: e.source,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    })),
  });
});

workspaceAppsRouter.post('/calendar', requireAuth, (req, res) => {
  const parsed = calendarEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid event title, start, and end timestamps required' });
    return;
  }
  const d = parsed.data;
  const startMs = new Date(d.startAt).getTime();
  const endMs = new Date(d.endAt).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    res.status(400).json({ error: 'End time must be after start time' });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO calendar_events (
      id, user_id, account_id, thread_id, message_id, title, description, location, meeting_url,
      start_at, end_at, all_day, timezone, status, attendees_json, reminder_minutes, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.auth!.id,
    d.accountId || null,
    d.threadId || null,
    d.messageId || null,
    d.title,
    d.description,
    d.location,
    d.meetingUrl,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
    d.allDay ? 1 : 0,
    d.timezone,
    d.status,
    JSON.stringify(d.attendees),
    d.reminderMinutes,
    d.source,
    now,
    now
  );

  eventBus.emit(req.auth!.id, 'calendar_updated', { eventId: id });
  res.status(201).json({ id });
});

workspaceAppsRouter.patch('/calendar/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as Record<string, any> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  const parsed = calendarEventSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event update' });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `UPDATE calendar_events
     SET title = ?, description = ?, location = ?, meeting_url = ?, start_at = ?, end_at = ?, all_day = ?,
         timezone = ?, status = ?, attendees_json = ?, reminder_minutes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    d.title ?? existing.title,
    d.description ?? existing.description,
    d.location ?? existing.location,
    d.meetingUrl ?? existing.meeting_url,
    d.startAt ? new Date(d.startAt).toISOString() : existing.start_at,
    d.endAt ? new Date(d.endAt).toISOString() : existing.end_at,
    d.allDay !== undefined ? (d.allDay ? 1 : 0) : existing.all_day,
    d.timezone ?? existing.timezone,
    d.status ?? existing.status,
    d.attendees ? JSON.stringify(d.attendees) : existing.attendees_json,
    d.reminderMinutes ?? existing.reminder_minutes,
    new Date().toISOString(),
    existing.id,
    req.auth!.id
  );
  eventBus.emit(req.auth!.id, 'calendar_updated', { eventId: existing.id });
  res.json({ ok: true });
});

workspaceAppsRouter.delete('/calendar/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  eventBus.emit(req.auth!.id, 'calendar_updated', { eventId: param(req, 'id') });
  res.json({ ok: true });
});

workspaceAppsRouter.post('/calendar/extract-from-thread/:threadId', requireAuth, (req, res) => {
  const db = getDb();
  const thread = db
    .prepare('SELECT id, account_id, subject FROM threads WHERE id = ? AND user_id = ?')
    .get(param(req, 'threadId'), req.auth!.id) as { id: string; account_id: string; subject: string } | undefined;
  if (!thread) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const msgs = db
    .prepare('SELECT id, from_name, from_address, body_text, received_at FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY received_at DESC LIMIT 5')
    .all(thread.id, req.auth!.id) as Array<{ id: string; from_name: string; from_address: string; body_text: string; received_at: string }>;

  const combined = msgs.map((m) => m.body_text).join('\n');
  const urlMatch = combined.match(/https?:\/\/(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)[^\s<>"']+/i);
  const isoDateMatch = combined.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const timeMatch = combined.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);

  const baseDate = isoDateMatch ? new Date(`${isoDateMatch[1]}T09:00:00`) : new Date(Date.now() + 86_400_000);
  if (timeMatch) {
    let hour = Number(timeMatch[1]) % 12;
    if (timeMatch[3].toUpperCase() === 'PM') hour += 12;
    const min = Number(timeMatch[2] || 0);
    baseDate.setHours(hour, min, 0, 0);
  } else if (!isoDateMatch) {
    baseDate.setHours(10, 0, 0, 0);
  }
  const endDate = new Date(baseDate.getTime() + 3600_000);
  const latest = msgs[0];

  res.json({
    candidate: {
      accountId: thread.account_id,
      threadId: thread.id,
      messageId: latest?.id || null,
      title: thread.subject.replace(/^(?:re|fwd|fw):\s*/i, '').trim() || 'Scheduled Meeting',
      description: latest ? `Extracted from email by ${latest.from_name || latest.from_address}` : '',
      location: urlMatch ? 'Online Meeting' : '',
      meetingUrl: urlMatch ? urlMatch[0] : '',
      startAt: baseDate.toISOString(),
      endAt: endDate.toISOString(),
      attendees: latest ? [{ name: latest.from_name, address: latest.from_address }] : [],
      source: 'extracted',
    },
  });
});

function formatIcsStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

workspaceAppsRouter.get('/calendar/:id/ics', requireAuth, (req, res) => {
  const db = getDb();
  const ev = db
    .prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as Record<string, any> | undefined;
  if (!ev) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  const esc = (v: string) => String(v || '').replace(/[\r\n]+/g, '\\n').replace(/([,;])/g, '\\$1');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cadence Mail//Workspace Calendar//EN',
    'BEGIN:VEVENT',
    `UID:${ev.id}@cadence.local`,
    `DTSTAMP:${formatIcsStamp(ev.created_at)}`,
    `DTSTART:${formatIcsStamp(ev.start_at)}`,
    `DTEND:${formatIcsStamp(ev.end_at)}`,
    `SUMMARY:${esc(ev.title)}`,
    `DESCRIPTION:${esc(ev.description)}`,
    ev.location ? `LOCATION:${esc(ev.location)}` : '',
    `STATUS:${String(ev.status || 'CONFIRMED').toUpperCase()}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="event-${ev.id.slice(0, 8)}.ics"`);
  res.send(ics);
});

workspaceAppsRouter.post('/calendar/import-ics', requireAuth, (req, res) => {
  const icsText = String(req.body?.icsText || '');
  if (!icsText.includes('BEGIN:VEVENT')) {
    res.status(400).json({ error: 'Valid RFC 5545 ICS content containing BEGIN:VEVENT is required' });
    return;
  }
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  const db = getDb();
  const now = new Date().toISOString();
  let imported = 0;

  const parseIcsDate = (raw: string): string => {
    const clean = raw.trim().replace(/^.*:/, '');
    const m = clean.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) return new Date().toISOString();
    const iso = m[4]
      ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`
      : `${m[1]}-${m[2]}-${m[3]}T09:00:00Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  };

  for (const b of blocks.slice(0, 50)) {
    const summary = (b.match(/^SUMMARY[^:]*:(.*)$/im)?.[1] || 'Imported Event').replace(/\\n/g, ' ').trim();
    const desc = (b.match(/^DESCRIPTION[^:]*:(.*)$/im)?.[1] || '').replace(/\\n/g, '\n').trim();
    const loc = (b.match(/^LOCATION[^:]*:(.*)$/im)?.[1] || '').replace(/\\n/g, ' ').trim();
    const dtStartRaw = b.match(/^DTSTART[^:]*:(.*)$/im)?.[1];
    const dtEndRaw = b.match(/^DTEND[^:]*:(.*)$/im)?.[1];
    const startAt = dtStartRaw ? parseIcsDate(dtStartRaw) : now;
    const endAt = dtEndRaw ? parseIcsDate(dtEndRaw) : new Date(new Date(startAt).getTime() + 3600_000).toISOString();
    db.prepare(
      `INSERT INTO calendar_events (
        id, user_id, title, description, location, start_at, end_at, all_day, timezone, status, attendees_json, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'UTC', 'confirmed', '[]', 'ics', ?, ?)`
    ).run(crypto.randomUUID(), req.auth!.id, summary, desc, loc, startAt, endAt, now, now);
    imported += 1;
  }

  eventBus.emit(req.auth!.id, 'calendar_updated', { imported });
  res.status(201).json({ imported });
});

// =========================
// 3. ATTACHMENT LIBRARY
// =========================
workspaceAppsRouter.get('/attachments', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const q = String(req.query.q || '').trim().toLowerCase();
  const type = String(req.query.type || 'all');
  const accountId = req.query.accountId ? String(req.query.accountId) : null;
  const sort = String(req.query.sort || 'newest');

  const rows = db
    .prepare(
      `SELECT att.id, att.message_id, att.filename, att.mime_type, att.size_bytes, att.sha256, att.created_at,
              m.thread_id, m.account_id, m.from_name, m.from_address,
              t.subject AS thread_subject,
              a.email_address AS account_email
       FROM attachments att
       JOIN messages m ON m.id = att.message_id
       JOIN threads t ON t.id = m.thread_id
       JOIN accounts a ON a.id = m.account_id
       WHERE att.user_id = ? AND m.is_draft = 0 AND m.is_trash = 0`
    )
    .all(userId) as Array<Record<string, any>>;

  const shaCounts = new Map<string, number>();
  let totalBytes = 0;
  for (const r of rows) {
    totalBytes += r.size_bytes || 0;
    shaCounts.set(r.sha256, (shaCounts.get(r.sha256) || 0) + 1);
  }

  const matchesType = (mime: string, name: string): boolean => {
    const ml = mime.toLowerCase();
    const nl = name.toLowerCase();
    if (type === 'image') return ml.startsWith('image/');
    if (type === 'document') {
      return ml.includes('pdf') || ml.includes('word') || ml.includes('text/') || /\.(pdf|docx?|txt|md|rtf)$/i.test(nl);
    }
    if (type === 'spreadsheet') {
      return ml.includes('csv') || ml.includes('excel') || ml.includes('sheet') || /\.(csv|xlsx?|ods)$/i.test(nl);
    }
    if (type === 'archive') {
      return ml.includes('zip') || ml.includes('tar') || ml.includes('gzip') || /\.(zip|tar|gz|7z|rar)$/i.test(nl);
    }
    if (type === 'other') {
      return !ml.startsWith('image/') && !ml.includes('pdf') && !ml.includes('text/') && !ml.includes('csv') && !ml.includes('zip');
    }
    return true;
  };

  let items = rows
    .filter((r) => {
      if (accountId && r.account_id !== accountId) return false;
      if (!matchesType(r.mime_type, r.filename)) return false;
      if (q) {
        const hay = `${r.filename} ${r.thread_subject} ${r.from_name} ${r.from_address}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((r) => ({
      id: r.id,
      messageId: r.message_id,
      threadId: r.thread_id,
      threadSubject: r.thread_subject,
      accountId: r.account_id,
      accountEmail: r.account_email,
      fromName: r.from_name,
      fromAddress: r.from_address,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      duplicateCount: shaCounts.get(r.sha256) || 1,
      createdAt: r.created_at,
    }));

  if (sort === 'largest') items = items.sort((a, b) => b.sizeBytes - a.sizeBytes);
  else if (sort === 'name') items = items.sort((a, b) => a.filename.localeCompare(b.filename));
  else items = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({
    attachments: items.slice(0, 250),
    stats: {
      totalCount: rows.length,
      totalBytes,
      duplicateGroups: [...shaCounts.values()].filter((c) => c > 1).length,
    },
  });
});

// =========================
// 4. MULTI-SIGNATURES
// =========================
workspaceAppsRouter.get('/signatures', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const accountId = req.query.accountId ? String(req.query.accountId) : null;

  const accts = db
    .prepare('SELECT id, display_name, signature_html FROM accounts WHERE user_id = ?')
    .all(userId) as Array<{ id: string; display_name: string; signature_html: string }>;

  // Backfill primary signature row for any existing account lacking rows
  const now = new Date().toISOString();
  for (const a of accts) {
    const cntRow = db.prepare('SELECT COUNT(*) AS cnt FROM account_signatures WHERE account_id = ?').get(a.id) as { cnt: number };
    if (cntRow.cnt === 0 && a.signature_html) {
      db.prepare(
        'INSERT INTO account_signatures (id, user_id, account_id, name, body_html, body_text, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
      ).run(crypto.randomUUID(), userId, a.id, 'Default Signature', a.signature_html, a.signature_html.replace(/<[^>]+>/g, ' ').trim(), now, now);
    }
  }

  const rows = accountId
    ? (db.prepare('SELECT * FROM account_signatures WHERE user_id = ? AND account_id = ? ORDER BY is_default DESC, name ASC').all(userId, accountId) as Array<Record<string, any>>)
    : (db.prepare('SELECT * FROM account_signatures WHERE user_id = ? ORDER BY is_default DESC, name ASC').all(userId) as Array<Record<string, any>>);

  res.json({
    signatures: rows.map((s) => ({
      id: s.id,
      accountId: s.account_id,
      name: s.name,
      bodyHtml: s.body_html,
      bodyText: s.body_text,
      isDefault: Boolean(s.is_default),
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    })),
  });
});

workspaceAppsRouter.post('/signatures', requireAuth, (req, res) => {
  const schema = z.object({
    accountId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    bodyHtml: z.string().max(50_000).default(''),
    bodyText: z.string().max(20_000).default(''),
    isDefault: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid account and signature name required' });
    return;
  }
  const db = getDb();
  const userId = req.auth!.id;
  const acct = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(parsed.data.accountId, userId);
  if (!acct) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  const cleanHtml = sanitizeComposerHtml(parsed.data.bodyHtml);
  const plain = parsed.data.bodyText || cleanHtml.replace(/<[^>]+>/g, ' ').trim();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  if (parsed.data.isDefault) {
    db.prepare('UPDATE account_signatures SET is_default = 0 WHERE account_id = ? AND user_id = ?').run(parsed.data.accountId, userId);
    db.prepare('UPDATE accounts SET signature_html = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(cleanHtml, now, parsed.data.accountId, userId);
  }

  db.prepare(
    'INSERT INTO account_signatures (id, user_id, account_id, name, body_html, body_text, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, parsed.data.accountId, parsed.data.name, cleanHtml, plain, parsed.data.isDefault ? 1 : 0, now, now);

  res.status(201).json({ id });
});

workspaceAppsRouter.patch('/signatures/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM account_signatures WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as Record<string, any> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Signature not found' });
    return;
  }
  const now = new Date().toISOString();
  const nextHtml = req.body?.bodyHtml !== undefined ? sanitizeComposerHtml(String(req.body.bodyHtml)) : existing.body_html;
  const nextName = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : existing.name;
  const nextText = typeof req.body?.bodyText === 'string' ? req.body.bodyText : nextHtml.replace(/<[^>]+>/g, ' ').trim();
  const makeDefault = typeof req.body?.isDefault === 'boolean' ? req.body.isDefault : Boolean(existing.is_default);

  if (makeDefault) {
    db.prepare('UPDATE account_signatures SET is_default = 0 WHERE account_id = ? AND user_id = ?').run(existing.account_id, req.auth!.id);
    db.prepare('UPDATE accounts SET signature_html = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(nextHtml, now, existing.account_id, req.auth!.id);
  }
  db.prepare('UPDATE account_signatures SET name = ?, body_html = ?, body_text = ?, is_default = ?, updated_at = ? WHERE id = ?').run(
    nextName,
    nextHtml,
    nextText,
    makeDefault ? 1 : 0,
    now,
    existing.id
  );
  res.json({ ok: true });
});

workspaceAppsRouter.delete('/signatures/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM account_signatures WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// =========================
// 5. COLLABORATION & SHARED MAILBOXES (STRICT TENANT/MEMBER ISOLATION)
// =========================
const ROLE_RANK: Record<'viewer' | 'agent' | 'admin' | 'owner', number> = {
  viewer: 1,
  agent: 2,
  admin: 3,
  owner: 4,
};

function getSharedMembership(
  db: ReturnType<typeof getDb>,
  mailboxId: string,
  userId: string,
  minRole: 'viewer' | 'agent' | 'admin' | 'owner'
) {
  const row = db
    .prepare(
      `SELECT sm.*, m.role AS member_role
       FROM shared_mailboxes sm
       JOIN shared_mailbox_members m ON m.mailbox_id = sm.id
       WHERE sm.id = ? AND m.user_id = ?`
    )
    .get(mailboxId, userId) as { id: string; name: string; account_id: string; owner_user_id: string; member_role: 'viewer' | 'agent' | 'admin' | 'owner' } | undefined;
  if (!row) return null;
  if (ROLE_RANK[row.member_role] < ROLE_RANK[minRole]) return 'FORBIDDEN' as const;
  return row;
}

workspaceAppsRouter.get('/collaboration/mailboxes', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT sm.*, a.email_address, m.role AS member_role,
              (SELECT COUNT(*) FROM shared_mailbox_members mm WHERE mm.mailbox_id = sm.id) AS member_count,
              (SELECT COUNT(*) FROM threads t WHERE t.account_id = sm.account_id AND t.in_inbox = 1) AS open_threads
       FROM shared_mailboxes sm
       JOIN shared_mailbox_members m ON m.mailbox_id = sm.id
       JOIN accounts a ON a.id = sm.account_id
       WHERE m.user_id = ?
       ORDER BY sm.name ASC`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    mailboxes: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      accountId: r.account_id,
      emailAddress: r.email_address,
      ownerUserId: r.owner_user_id,
      role: r.member_role,
      memberCount: r.member_count,
      openThreads: r.open_threads,
      createdAt: r.created_at,
    })),
  });
});

workspaceAppsRouter.post('/collaboration/mailboxes', requireAuth, (req, res) => {
  const schema = z.object({
    accountId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(240).default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Mailbox name and owned accountId are required' });
    return;
  }
  const db = getDb();
  const userId = req.auth!.id;
  // Strictly ensure caller owns the mailbox being converted into a shared inbox
  const acct = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(parsed.data.accountId, userId);
  if (!acct) {
    res.status(404).json({ error: 'Account not found or not owned by your user' });
    return;
  }
  if (db.prepare('SELECT id FROM shared_mailboxes WHERE account_id = ?').get(parsed.data.accountId)) {
    res.status(409).json({ error: 'This mailbox is already configured as a shared inbox' });
    return;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO shared_mailboxes (id, name, description, account_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, parsed.data.name, parsed.data.description, parsed.data.accountId, userId, now, now);
  db.prepare(
    "INSERT INTO shared_mailbox_members (mailbox_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)"
  ).run(id, userId, now);

  res.status(201).json({ id });
});

workspaceAppsRouter.get('/collaboration/mailboxes/:id/members', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'viewer');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Insufficient shared mailbox permissions' });
    return;
  }
  const members = db
    .prepare(
      `SELECT u.id AS user_id, u.name, u.email, m.role, m.added_at
       FROM shared_mailbox_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.mailbox_id = ?
       ORDER BY m.added_at ASC`
    )
    .all(access.id);
  res.json({ members });
});

workspaceAppsRouter.post('/collaboration/mailboxes/:id/members', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'admin');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Admin or owner permission required to add members' });
    return;
  }
  const schema = z.object({
    email: z.string().trim().email(),
    role: z.enum(['admin', 'agent', 'viewer']).default('agent'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid workspace user email and role required' });
    return;
  }
  const targetUser = db
    .prepare("SELECT id, name, email FROM users WHERE lower(email) = lower(?) AND status = 'active'")
    .get(parsed.data.email) as { id: string; name: string; email: string } | undefined;
  if (!targetUser) {
    res.status(404).json({ error: 'No active workspace user found with that email address' });
    return;
  }
  db.prepare(
    `INSERT INTO shared_mailbox_members (mailbox_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(access.id, targetUser.id, parsed.data.role, new Date().toISOString());

  res.status(201).json({ member: { user_id: targetUser.id, name: targetUser.name, email: targetUser.email, role: parsed.data.role } });
});

workspaceAppsRouter.delete('/collaboration/mailboxes/:id/members/:memberUserId', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'admin');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Admin or owner permission required' });
    return;
  }
  const targetId = param(req, 'memberUserId');
  if (targetId === access.owner_user_id) {
    res.status(400).json({ error: 'Cannot remove shared mailbox owner' });
    return;
  }
  db.prepare('DELETE FROM shared_mailbox_members WHERE mailbox_id = ? AND user_id = ?').run(access.id, targetId);
  res.json({ ok: true });
});

workspaceAppsRouter.get('/collaboration/mailboxes/:id/threads', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'viewer');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Shared mailbox membership required' });
    return;
  }

  // Only fetch threads for the explicitly shared account_id (never expose private accounts!)
  const rows = db
    .prepare(
      `SELECT t.id, t.subject, t.snippet, t.last_message_at, t.unread_count, t.participants_json,
              ta.assigned_to_user_id, u.name AS assignee_name, COALESCE(ta.status, 'open') AS triage_status,
              (SELECT COUNT(*) FROM thread_notes tn WHERE tn.thread_id = t.id AND tn.mailbox_id = ?) AS note_count
       FROM threads t
       LEFT JOIN thread_assignments ta ON ta.thread_id = t.id AND ta.mailbox_id = ?
       LEFT JOIN users u ON u.id = ta.assigned_to_user_id
       WHERE t.account_id = ? AND t.in_trash = 0 AND t.in_spam = 0
       ORDER BY t.last_message_at DESC
       LIMIT 80`
    )
    .all(access.id, access.id, access.account_id) as Array<Record<string, any>>;

  res.json({
    threads: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      snippet: r.snippet,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count,
      participants: JSON.parse(r.participants_json || '[]'),
      assignedToUserId: r.assigned_to_user_id || null,
      assigneeName: r.assignee_name || null,
      triageStatus: r.triage_status,
      noteCount: r.note_count || 0,
    })),
  });
});

workspaceAppsRouter.post('/collaboration/mailboxes/:id/threads/:threadId/assign', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'agent');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Viewer role cannot modify shared thread assignments' });
    return;
  }
  const threadRow = db
    .prepare('SELECT id FROM threads WHERE id = ? AND account_id = ?')
    .get(param(req, 'threadId'), access.account_id);
  if (!threadRow) {
    res.status(404).json({ error: 'Thread does not belong to this shared mailbox' });
    return;
  }

  const assignedToUserId = req.body?.assignedToUserId ? String(req.body.assignedToUserId) : null;
  if (assignedToUserId) {
    const isMember = db
      .prepare('SELECT user_id FROM shared_mailbox_members WHERE mailbox_id = ? AND user_id = ?')
      .get(access.id, assignedToUserId);
    if (!isMember) {
      res.status(400).json({ error: 'Assignee must be a member of this shared mailbox' });
      return;
    }
  }
  const status = ['open', 'pending', 'resolved'].includes(String(req.body?.status)) ? String(req.body.status) : 'open';
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO thread_assignments (thread_id, mailbox_id, assigned_to_user_id, assigned_by_user_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       assigned_to_user_id = excluded.assigned_to_user_id,
       assigned_by_user_id = excluded.assigned_by_user_id,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(param(req, 'threadId'), access.id, assignedToUserId, req.auth!.id, status, now);

  res.json({ ok: true });
});

workspaceAppsRouter.get('/collaboration/mailboxes/:id/threads/:threadId/notes', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'viewer');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Shared mailbox membership required' });
    return;
  }
  const notes = db
    .prepare(
      'SELECT id, thread_id, mailbox_id, author_user_id, author_name, body, created_at FROM thread_notes WHERE thread_id = ? AND mailbox_id = ? ORDER BY created_at ASC'
    )
    .all(param(req, 'threadId'), access.id) as Array<Record<string, any>>;

  res.json({
    notes: notes.map((n) => ({
      id: n.id,
      threadId: n.thread_id,
      mailboxId: n.mailbox_id,
      authorUserId: n.author_user_id,
      authorName: n.author_name,
      body: n.body,
      createdAt: n.created_at,
    })),
  });
});

/** Shared conversation detail & attachments reader scoped strictly to verified mailbox members. */
workspaceAppsRouter.get('/collaboration/mailboxes/:id/threads/:threadId', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'viewer');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Shared mailbox membership required' });
    return;
  }

  const thread = db
    .prepare('SELECT id, subject, account_id FROM threads WHERE id = ? AND account_id = ?')
    .get(param(req, 'threadId'), access.account_id) as { id: string; subject: string; account_id: string } | undefined;
  if (!thread) {
    res.status(404).json({ error: 'Conversation does not belong to this shared mailbox' });
    return;
  }

  const msgs = db
    .prepare(
      `SELECT id, from_name, from_address, to_json, cc_json, subject, body_html_sanitized, body_text,
              received_at, sent_at, has_attachments, delivery_status
       FROM messages
       WHERE thread_id = ? AND account_id = ? AND is_draft = 0
       ORDER BY received_at ASC`
    )
    .all(thread.id, access.account_id) as Array<Record<string, any>>;

  const attStmt = db.prepare('SELECT id, filename, mime_type, size_bytes, is_inline FROM attachments WHERE message_id = ?');

  res.json({
    thread: { id: thread.id, subject: thread.subject, mailboxId: access.id },
    messages: msgs.map((m) => ({
      id: m.id,
      fromName: m.from_name,
      fromAddress: m.from_address,
      to: JSON.parse(m.to_json || '[]'),
      cc: JSON.parse(m.cc_json || '[]'),
      subject: m.subject,
      bodyHtmlSanitized: m.body_html_sanitized,
      bodyText: m.body_text,
      receivedAt: m.received_at,
      sentAt: m.sent_at,
      deliveryStatus: m.delivery_status,
      attachments: attStmt.all(m.id).map((a: any) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        isInline: Boolean(a.is_inline),
      })),
    })),
  });
});

/** Scoped attachment download for shared mailbox members without exposing private mailbox files. */
workspaceAppsRouter.get('/collaboration/mailboxes/:id/attachments/:attId', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'viewer');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Shared mailbox membership required' });
    return;
  }

  const att = db
    .prepare(
      `SELECT a.filename, a.mime_type, a.storage_path
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND m.account_id = ?`
    )
    .get(param(req, 'attId'), access.account_id) as { filename: string; mime_type: string; storage_path: string } | undefined;

  if (!att || !att.storage_path || !fs.existsSync(att.storage_path)) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  const safeName = path.basename(att.filename).replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.sendFile(path.resolve(att.storage_path));
});

workspaceAppsRouter.post('/collaboration/mailboxes/:id/threads/:threadId/notes', requireAuth, (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'agent');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Viewer role cannot post internal notes' });
    return;
  }
  const threadRow = db
    .prepare('SELECT id FROM threads WHERE id = ? AND account_id = ?')
    .get(param(req, 'threadId'), access.account_id);
  if (!threadRow) {
    res.status(404).json({ error: 'Thread does not belong to this shared mailbox' });
    return;
  }
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > 4000) {
    res.status(400).json({ error: 'Internal note text (1-4000 chars) is required' });
    return;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO thread_notes (id, thread_id, mailbox_id, author_user_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, param(req, 'threadId'), access.id, req.auth!.id, req.auth!.name, body, now);

  res.status(201).json({
    note: {
      id,
      threadId: param(req, 'threadId'),
      mailboxId: access.id,
      authorUserId: req.auth!.id,
      authorName: req.auth!.name,
      body,
      createdAt: now,
    },
  });
});

/** Sends an external reply on behalf of the shared mailbox (requires agent/admin/owner role). */
workspaceAppsRouter.post('/collaboration/mailboxes/:id/threads/:threadId/reply', requireAuth, async (req, res) => {
  const db = getDb();
  const access = getSharedMembership(db, param(req, 'id'), req.auth!.id, 'agent');
  if (!access) {
    res.status(404).json({ error: 'Shared mailbox not found' });
    return;
  }
  if (access === 'FORBIDDEN') {
    res.status(403).json({ error: 'Viewer role cannot send replies from shared mailbox' });
    return;
  }

  const threadRow = db
    .prepare('SELECT id, subject, account_id FROM threads WHERE id = ? AND account_id = ?')
    .get(param(req, 'threadId'), access.account_id) as { id: string; subject: string; account_id: string } | undefined;
  if (!threadRow) {
    res.status(404).json({ error: 'Thread does not belong to this shared mailbox' });
    return;
  }

  const bodyText = String(req.body?.text || '').trim();
  if (!bodyText || bodyText.length > 20_000) {
    res.status(400).json({ error: 'Reply body text (1-20000 chars) is required' });
    return;
  }

  const sharedAccount = db
    .prepare('SELECT id, user_id, email_address FROM accounts WHERE id = ?')
    .get(access.account_id) as { id: string; user_id: string; email_address: string } | undefined;
  if (!sharedAccount) {
    res.status(404).json({ error: 'Shared mailbox account not found' });
    return;
  }

  const msgs = db
    .prepare(
      `SELECT id, from_name, from_address, to_json, cc_json, reply_to_json, subject
       FROM messages WHERE thread_id = ? AND account_id = ? AND is_draft = 0
       ORDER BY received_at ASC`
    )
    .all(threadRow.id, access.account_id) as Array<{
    id: string;
    from_name: string;
    from_address: string;
    to_json: string;
    cc_json: string;
    reply_to_json: string;
    subject: string;
  }>;
  if (msgs.length === 0) {
    res.status(400).json({ error: 'Conversation has no messages to reply to' });
    return;
  }

  const latest = msgs[msgs.length - 1];
  const ownEmail = sharedAccount.email_address.toLowerCase();
  const replyTargets: Array<{ name: string; address: string }> = [];
  const pushUnique = (list: Array<{ name?: string; address: string }>) => {
    for (const p of list) {
      const addr = String(p.address || '').trim().toLowerCase();
      if (!addr || addr === ownEmail) continue;
      if (!replyTargets.some((x) => x.address.toLowerCase() === addr)) {
        replyTargets.push({ name: p.name || '', address: p.address });
      }
    }
  };

  const latestReplyTo = JSON.parse(latest.reply_to_json || '[]') as Array<{ name: string; address: string }>;
  if (latestReplyTo.length > 0) {
    pushUnique(latestReplyTo);
  }
  if (replyTargets.length === 0 && latest.from_address.toLowerCase() !== ownEmail) {
    pushUnique([{ name: latest.from_name, address: latest.from_address }]);
  }
  if (replyTargets.length === 0) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].from_address.toLowerCase() !== ownEmail) {
        pushUnique([{ name: msgs[i].from_name, address: msgs[i].from_address }]);
        break;
      }
      pushUnique(JSON.parse(msgs[i].to_json || '[]'));
    }
  }
  if (replyTargets.length === 0) {
    pushUnique([{ name: latest.from_name, address: latest.from_address }]);
  }

  const ccTargets: Array<{ name: string; address: string }> = [];
  if (req.body?.replyAll) {
    for (const p of [...JSON.parse(latest.to_json || '[]'), ...JSON.parse(latest.cc_json || '[]')]) {
      const addr = String(p.address || '').trim().toLowerCase();
      if (
        addr &&
        addr !== ownEmail &&
        !replyTargets.some((r) => r.address.toLowerCase() === addr) &&
        !ccTargets.some((c) => c.address.toLowerCase() === addr)
      ) {
        ccTargets.push({ name: p.name || '', address: p.address });
      }
    }
  }

  const draftId = crypto.randomUUID();
  const now = new Date().toISOString();
  const subject = threadRow.subject.toLowerCase().startsWith('re:') ? threadRow.subject : `Re: ${threadRow.subject}`;
  const htmlBody = `<p>${bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;

  db.prepare(
    `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 0, 'sending', 1, ?, ?)`
  ).run(
    draftId,
    sharedAccount.user_id,
    sharedAccount.id,
    threadRow.id,
    latest.id,
    req.body?.replyAll ? 'reply_all' : 'reply',
    JSON.stringify(replyTargets),
    JSON.stringify(ccTargets),
    subject,
    htmlBody,
    bodyText,
    now,
    now
  );

  const sendRes = await dispatchDraftNow(db, draftId);
  if (!sendRes.ok) {
    res.status(502).json({ error: sendRes.error || 'Failed to send shared mailbox reply' });
    return;
  }

  db.prepare(
    'INSERT INTO thread_notes (id, thread_id, mailbox_id, author_user_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    crypto.randomUUID(),
    threadRow.id,
    access.id,
    req.auth!.id,
    req.auth!.name,
    `Sent shared reply to ${replyTargets.map((r) => r.address).join(', ')}`,
    new Date().toISOString()
  );

  res.status(200).json({ ok: true, messageId: sendRes.messageId, recipients: replyTargets.map((r) => r.address) });
});
