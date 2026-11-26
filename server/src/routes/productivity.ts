import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import { sanitizeComposerHtml } from '../security/sanitize.js';
import { seedStarterCorrespondence } from '../services/accountSetup.js';
import {
  deriveSearchQueryFromNaturalLanguage,
  getAiProviderStatus,
  planAiWorkflowSteps,
  runAiSmartReplies,
  runAiThreadAnalysis,
  runAiTransform,
  runAiTranslate,
  synthesizeAiSearchAnswer,
  type AiTone,
} from '../services/aiService.js';
import { executeSearch } from '../services/searchService.js';
import { hydrateThreadList } from './threads.js';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '../types.js';

export const productivityRouter = Router();

// --- CONTACTS ---
productivityRouter.get('/contacts', requireAuth, (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim().toLowerCase();
  const groupId = req.query.groupId ? String(req.query.groupId) : null;

  let sql = `SELECT c.* FROM contacts c WHERE c.user_id = ?`;
  const params: Array<string> = [req.auth!.id];

  if (groupId) {
    sql += ` AND EXISTS (SELECT 1 FROM contact_group_members gm WHERE gm.contact_id = c.id AND gm.group_id = ?)`;
    params.push(groupId);
  }
  if (q) {
    sql += ` AND (lower(c.name) LIKE ? OR lower(c.email) LIKE ? OR lower(c.organization) LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY c.is_favorite DESC, c.contact_count DESC, c.name ASC`;

  const rows = db.prepare(sql).all(...params) as Array<Record<string, any>>;
  const groupStmt = db.prepare(
    `SELECT g.id, g.name, g.color FROM contact_groups g JOIN contact_group_members gm ON gm.group_id = g.id WHERE gm.contact_id = ?`
  );

  res.json({
    contacts: rows.map((c) => ({
      id: c.id,
      accountId: c.account_id || null,
      source: c.source || 'local',
      name: c.name,
      email: c.email,
      organization: c.organization,
      phone: c.phone,
      notes: c.notes,
      avatarColor: c.avatar_color,
      isFavorite: Boolean(c.is_favorite),
      contactCount: c.contact_count,
      lastContactedAt: c.last_contacted_at,
      customFields: JSON.parse(c.custom_fields_json || '{}'),
      groups: groupStmt.all(c.id),
    })),
  });
});

productivityRouter.get('/contacts/suggest', requireAuth, (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT id, name, email, organization, avatar_color, contact_count
       FROM contacts
       WHERE user_id = ? AND (? = '' OR lower(name) LIKE ? OR lower(email) LIKE ?)
       ORDER BY is_favorite DESC, contact_count DESC, last_contacted_at DESC
       LIMIT 10`
    )
    .all(req.auth!.id, q, `%${q}%`, `%${q}%`) as Array<Record<string, any>>;

  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.color,
              (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.group_id = g.id) AS member_count
       FROM contact_groups g
       WHERE g.user_id = ? AND (? = '' OR lower(g.name) LIKE ?)
       LIMIT 5`
    )
    .all(req.auth!.id, q, `%${q}%`) as Array<Record<string, any>>;

  const groupMemberStmt = db.prepare(
    `SELECT c.name, c.email FROM contacts c JOIN contact_group_members gm ON gm.contact_id = c.id WHERE gm.group_id = ?`
  );

  res.json({
    suggestions: rows.map((c) => ({
      id: c.id,
      accountId: c.account_id || null,
      source: c.source || 'local',
      name: c.name,
      email: c.email,
      organization: c.organization,
      avatarColor: c.avatar_color,
    })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      members: groupMemberStmt.all(g.id),
    })),
  });
});

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  organization: z.string().trim().max(120).default(''),
  phone: z.string().trim().max(40).default(''),
  notes: z.string().max(2000).default(''),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563EB'),
  isFavorite: z.boolean().default(false),
  customFields: z.record(z.string().max(200)).optional(),
  groupIds: z.array(z.string()).optional(),
});

productivityRouter.post('/contacts', requireAuth, (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid name and email address required' });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const d = parsed.data;
  const exists = db.prepare('SELECT id FROM contacts WHERE user_id = ? AND lower(email) = lower(?)').get(userId, d.email);
  if (exists) {
    res.status(409).json({ error: 'Contact with this email already exists' });
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, user_id, name, email, organization, phone, notes, avatar_color, is_favorite, contact_count, custom_fields_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(id, userId, d.name, d.email.toLowerCase(), d.organization, d.phone, d.notes, d.avatarColor, d.isFavorite ? 1 : 0, JSON.stringify(d.customFields || {}), now, now);

  if (d.groupIds) {
    for (const gid of d.groupIds) {
      db.prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)').run(gid, id);
    }
  }
  res.status(201).json({ id });
});

productivityRouter.patch('/contacts/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | Record<string, any>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }

  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid contact update' });
    return;
  }

  const d = parsed.data;
  db.prepare(
    `UPDATE contacts SET name = ?, email = ?, organization = ?, phone = ?, notes = ?, avatar_color = ?, is_favorite = ?, custom_fields_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    d.name ?? existing.name,
    d.email ? d.email.toLowerCase() : existing.email,
    d.organization ?? existing.organization,
    d.phone ?? existing.phone,
    d.notes ?? existing.notes,
    d.avatarColor ?? existing.avatar_color,
    d.isFavorite !== undefined ? (d.isFavorite ? 1 : 0) : existing.is_favorite,
    d.customFields !== undefined ? JSON.stringify(d.customFields) : existing.custom_fields_json || '{}',
    new Date().toISOString(),
    existing.id,
    req.auth!.id
  );

  if (d.groupIds) {
    db.prepare('DELETE FROM contact_group_members WHERE contact_id = ?').run(existing.id);
    for (const gid of d.groupIds) {
      db.prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)').run(gid, existing.id);
    }
  }
  res.json({ ok: true });
});

productivityRouter.delete('/contacts/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

productivityRouter.get('/contacts/export', requireAuth, (req, res) => {
  const db = getDb();
  const format = String(req.query.format || 'csv').toLowerCase();
  const rows = db
    .prepare('SELECT name, email, organization, phone, notes FROM contacts WHERE user_id = ? ORDER BY name ASC')
    .all(req.auth!.id) as Array<{ name: string; email: string; organization: string; phone: string; notes: string }>;

  if (format === 'vcf' || format === 'vcard') {
    const vcards = rows
      .map((c) =>
        [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `FN:${c.name || c.email}`,
          `EMAIL;TYPE=INTERNET:${c.email}`,
          c.organization ? `ORG:${c.organization}` : '',
          c.phone ? `TEL;TYPE=CELL:${c.phone}` : '',
          c.notes ? `NOTE:${c.notes.replace(/[\r\n]+/g, ' ')}` : '',
          'END:VCARD',
        ]
          .filter(Boolean)
          .join('\r\n')
      )
      .join('\r\n');
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cadence-contacts.vcf"');
    res.send(vcards);
    return;
  }

  const csvCell = (v: string) => `"${String(v || '').replace(/"/g, '""')}"`;
  const csv = [
    'Name,Email,Organization,Phone,Notes',
    ...rows.map((c) => [csvCell(c.name), csvCell(c.email), csvCell(c.organization), csvCell(c.phone), csvCell(c.notes)].join(',')),
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cadence-contacts.csv"');
  res.send(csv);
});

productivityRouter.post('/contacts/import', requireAuth, (req, res) => {
  const raw = String(req.body?.data || '');
  if (!raw.trim()) {
    res.status(400).json({ error: 'Contact import payload is required' });
    return;
  }
  const parsedContacts: Array<{ name: string; email: string; organization: string; phone: string; notes: string }> = [];
  if (raw.includes('BEGIN:VCARD')) {
    const blocks = raw.split('BEGIN:VCARD').slice(1);
    for (const b of blocks) {
      const fn = b.match(/^FN[^:]*:(.*)$/im)?.[1]?.trim() || '';
      const email = b.match(/^EMAIL[^:]*:(.*)$/im)?.[1]?.trim().toLowerCase() || '';
      const org = b.match(/^ORG[^:]*:(.*)$/im)?.[1]?.trim() || '';
      const tel = b.match(/^TEL[^:]*:(.*)$/im)?.[1]?.trim() || '';
      const note = b.match(/^NOTE[^:]*:(.*)$/im)?.[1]?.trim() || '';
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        parsedContacts.push({ name: fn || email.split('@')[0], email, organization: org, phone: tel, notes: note });
      }
    }
  } else {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(',').map((s) => s.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
      if (i === 0 && cols.some((c) => c.toLowerCase() === 'email')) continue;
      const emailIdx = cols.findIndex((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c));
      if (emailIdx === -1) continue;
      const email = cols[emailIdx].toLowerCase();
      const name = emailIdx > 0 && cols[0] ? cols[0] : cols[1] && !cols[1].includes('@') ? cols[1] : email.split('@')[0];
      parsedContacts.push({
        name,
        email,
        organization: cols[2] && !cols[2].includes('@') ? cols[2] : '',
        phone: cols[3] || '',
        notes: cols[4] || '',
      });
    }
  }

  const db = getDb();
  const now = new Date().toISOString();
  let imported = 0;
  let updated = 0;
  for (const c of parsedContacts.slice(0, 500)) {
    const existing = db.prepare('SELECT id, organization, phone, notes FROM contacts WHERE user_id = ? AND lower(email) = lower(?)').get(
      req.auth!.id,
      c.email
    ) as { id: string; organization: string; phone: string; notes: string } | undefined;
    if (existing) {
      db.prepare('UPDATE contacts SET name = COALESCE(NULLIF(?, \'\'), name), organization = COALESCE(NULLIF(?, \'\'), organization), phone = COALESCE(NULLIF(?, \'\'), phone), notes = COALESCE(NULLIF(?, \'\'), notes), updated_at = ? WHERE id = ?').run(
        c.name,
        c.organization,
        c.phone,
        c.notes,
        now,
        existing.id
      );
      updated += 1;
    } else {
      db.prepare(
        "INSERT INTO contacts (id, user_id, name, email, organization, phone, notes, avatar_color, is_favorite, contact_count, custom_fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '#2563EB', 0, 0, '{}', ?, ?)"
      ).run(crypto.randomUUID(), req.auth!.id, c.name, c.email, c.organization, c.phone, c.notes, now, now);
      imported += 1;
    }
  }
  res.json({ imported, updated, totalProcessed: parsedContacts.length });
});

productivityRouter.get('/contacts/duplicates', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, name, email, organization, phone FROM contacts WHERE user_id = ? ORDER BY name ASC')
    .all(req.auth!.id) as Array<{ id: string; name: string; email: string; organization: string; phone: string }>;

  const byName = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key) continue;
    const arr = byName.get(key) || [];
    arr.push(r);
    byName.set(key, arr);
  }
  const duplicateGroups = [...byName.values()].filter((g) => g.length > 1);
  res.json({ duplicateGroups });
});

productivityRouter.post('/contacts/merge', requireAuth, (req, res) => {
  const primaryId = String(req.body?.primaryId || '');
  const duplicateId = String(req.body?.duplicateId || '');
  if (!primaryId || !duplicateId || primaryId === duplicateId) {
    res.status(400).json({ error: 'Two distinct contact IDs required to merge' });
    return;
  }
  const db = getDb();
  const primary = db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(primaryId, req.auth!.id) as Record<string, any> | undefined;
  const dup = db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(duplicateId, req.auth!.id) as Record<string, any> | undefined;
  if (!primary || !dup) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }
  const mergedNotes = [primary.notes, dup.notes, dup.email !== primary.email ? `Merged alias: ${dup.email}` : '']
    .filter(Boolean)
    .join('\n');
  db.prepare(
    'UPDATE contacts SET organization = COALESCE(NULLIF(organization, \'\'), ?), phone = COALESCE(NULLIF(phone, \'\'), ?), notes = ?, contact_count = contact_count + ?, updated_at = ? WHERE id = ?'
  ).run(dup.organization, dup.phone, mergedNotes, dup.contact_count || 0, new Date().toISOString(), primary.id);
  db.prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) SELECT group_id, ? FROM contact_group_members WHERE contact_id = ?').run(
    primary.id,
    dup.id
  );
  db.prepare('UPDATE tasks SET contact_id = ? WHERE contact_id = ? AND user_id = ?').run(primary.id, dup.id, req.auth!.id);
  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(dup.id, req.auth!.id);
  res.json({ ok: true });
});

productivityRouter.get('/contacts/:id/activity', requireAuth, (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT id, email, name FROM contacts WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | { id: string; email: string; name: string }
    | undefined;
  if (!contact) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }
  const recentThreads = db
    .prepare(
      `SELECT DISTINCT t.id, t.subject, t.last_message_at, t.snippet
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.user_id = ? AND m.is_draft = 0 AND (lower(m.from_address) = lower(?) OR lower(m.to_json) LIKE ?)
       ORDER BY t.last_message_at DESC LIMIT 12`
    )
    .all(req.auth!.id, contact.email, `%${contact.email.toLowerCase()}%`);
  const linkedTasks = db
    .prepare('SELECT id, title, status, priority, due_at FROM tasks WHERE user_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(req.auth!.id, contact.id);
  const linkedEvents = db
    .prepare('SELECT id, title, start_at, end_at, status FROM calendar_events WHERE user_id = ? AND lower(attendees_json) LIKE ? ORDER BY start_at DESC LIMIT 10')
    .all(req.auth!.id, `%${contact.email.toLowerCase()}%`);

  res.json({ recentThreads, linkedTasks, linkedEvents });
});

productivityRouter.get('/contact-groups', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.group_id = g.id) AS member_count
       FROM contact_groups g WHERE g.user_id = ? ORDER BY g.name ASC`
    )
    .all(req.auth!.id);
  res.json({ groups: rows });
});

productivityRouter.post('/contact-groups', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const color = String(req.body?.color || '#4F46E5');
  if (!name) {
    res.status(400).json({ error: 'Group name is required' });
    return;
  }
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare('INSERT OR IGNORE INTO contact_groups (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    req.auth!.id,
    name,
    color,
    new Date().toISOString()
  );
  res.status(201).json({ id, name, color });
});

productivityRouter.delete('/contact-groups/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM contact_groups WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- TEMPLATES ---
productivityRouter.get('/templates', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.auth!.id) as Array<Record<string, any>>;
  res.json({
    templates: rows.map((t) => ({
      id: t.id,
      name: t.name,
      subject: t.subject,
      bodyHtml: t.body_html,
      category: t.category,
      shortcutKey: t.shortcut_key,
      updatedAt: t.updated_at,
    })),
  });
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  subject: z.string().max(300).default(''),
  bodyHtml: z.string().min(1).max(100_000),
  category: z.string().max(50).default('General'),
  shortcutKey: z.string().max(10).default(''),
});

productivityRouter.post('/templates', requireAuth, (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Template name and content are required' });
    return;
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO templates (id, user_id, name, subject, body_html, category, shortcut_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    req.auth!.id,
    parsed.data.name,
    parsed.data.subject,
    sanitizeComposerHtml(parsed.data.bodyHtml),
    parsed.data.category,
    parsed.data.shortcutKey,
    now,
    now
  );
  res.status(201).json({ id });
});

productivityRouter.patch('/templates/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | Record<string, any>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  const parsed = templateSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid template update' });
    return;
  }
  const d = parsed.data;
  db.prepare(
    'UPDATE templates SET name = ?, subject = ?, body_html = ?, category = ?, shortcut_key = ?, updated_at = ? WHERE id = ?'
  ).run(
    d.name ?? existing.name,
    d.subject ?? existing.subject,
    d.bodyHtml !== undefined ? sanitizeComposerHtml(d.bodyHtml) : existing.body_html,
    d.category ?? existing.category,
    d.shortcutKey ?? existing.shortcut_key,
    new Date().toISOString(),
    existing.id
  );
  res.json({ ok: true });
});

productivityRouter.delete('/templates/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- REMINDERS ---
productivityRouter.get('/reminders', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.*, t.subject AS thread_subject
       FROM reminders r
       LEFT JOIN threads t ON t.id = r.thread_id
       WHERE r.user_id = ?
       ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.due_at ASC`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    reminders: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      messageId: r.message_id,
      threadSubject: r.thread_subject,
      title: r.title,
      dueAt: r.due_at,
      status: r.status,
      createdAt: r.created_at,
    })),
  });
});

productivityRouter.post('/reminders', requireAuth, (req, res) => {
  const schema = z.object({
    threadId: z.string().nullable().optional(),
    messageId: z.string().nullable().optional(),
    title: z.string().trim().min(1).max(200),
    dueAt: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || Number.isNaN(new Date(parsed.data.dueAt).getTime())) {
    res.status(400).json({ error: 'Valid reminder title and due date required' });
    return;
  }
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO reminders (id, user_id, thread_id, message_id, title, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
  ).run(
    id,
    req.auth!.id,
    parsed.data.threadId || null,
    parsed.data.messageId || null,
    parsed.data.title,
    new Date(parsed.data.dueAt).toISOString(),
    new Date().toISOString()
  );
  res.status(201).json({ id });
});

productivityRouter.patch('/reminders/:id', requireAuth, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['pending', 'triggered', 'dismissed', 'completed'].includes(status)) {
    res.status(400).json({ error: 'Invalid reminder status' });
    return;
  }
  const db = getDb();
  db.prepare('UPDATE reminders SET status = ? WHERE id = ? AND user_id = ?').run(status, param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

productivityRouter.delete('/reminders/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- NOTIFICATIONS ---
productivityRouter.get('/notifications', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40')
    .all(req.auth!.id) as Array<Record<string, any>>;
  const unreadCount = rows.filter((n) => !n.is_read).length;
  res.json({
    unreadCount,
    notifications: rows.map((n) => ({
      id: n.id,
      accountId: n.account_id,
      threadId: n.thread_id,
      messageId: n.message_id,
      type: n.type,
      title: n.title,
      body: n.body,
      isRead: Boolean(n.is_read),
      createdAt: n.created_at,
    })),
  });
});

productivityRouter.post('/notifications/read-all', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.auth!.id);
  res.json({ ok: true });
});

productivityRouter.patch('/notifications/:id/read', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- PREFERENCES ---
function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function getUserPreferences(userId: string): UserPreferences {
  const db = getDb();
  const row = db.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?').get(userId) as
    | { preferences_json: string }
    | undefined;
  if (!row) return DEFAULT_USER_PREFERENCES;
  return deepMerge(DEFAULT_USER_PREFERENCES, JSON.parse(row.preferences_json));
}

productivityRouter.get('/preferences', requireAuth, (req, res) => {
  res.json({ preferences: getUserPreferences(req.auth!.id) });
});

productivityRouter.patch('/preferences', requireAuth, (req, res) => {
  const db = getDb();
  const current = getUserPreferences(req.auth!.id);
  const next = deepMerge(current, req.body || {});
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at`
  ).run(req.auth!.id, JSON.stringify(next), now);
  res.json({ preferences: next });
});

// --- AI ASSISTANT ---
function requireAiConsent(userId: string): { ok: true; prefs: UserPreferences } | { ok: false; status: number; body: any } {
  const prefs = getUserPreferences(userId);
  if (!prefs.ai.enabled || !prefs.ai.privacyDisclosureAccepted) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'AI Assistant is disabled or privacy consent has not been accepted.',
        code: 'AI_CONSENT_REQUIRED',
      },
    };
  }
  const providerStatus = getAiProviderStatus();
  if (!providerStatus.configured) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'No server-side AI API key is configured.',
        code: 'AI_UNCONFIGURED',
        ...providerStatus,
      },
    };
  }
  return { ok: true, prefs };
}

productivityRouter.get('/ai/status', requireAuth, (req, res) => {
  const prefs = getUserPreferences(req.auth!.id);
  res.json({
    enabledByUser: prefs.ai.enabled,
    privacyDisclosureAccepted: prefs.ai.privacyDisclosureAccepted,
    redactSensitiveContent: prefs.ai.redactSensitiveContent,
    provider: getAiProviderStatus(),
  });
});

productivityRouter.post('/ai/transform', requireAuth, async (req, res) => {
  const gate = requireAiConsent(req.auth!.id);
  if (!gate.ok) {
    res.status(gate.status).json(gate.body);
    return;
  }
  const schema = z.object({
    action: z.enum(['generate', 'rewrite', 'grammar', 'clarity', 'shorten', 'expand', 'summarize', 'tone']),
    instructions: z.string().max(2000).optional(),
    content: z.string().max(20_000).default(''),
    tone: z.enum(['professional', 'formal', 'friendly', 'neutral', 'polite', 'confident', 'concise']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid AI transform request' });
    return;
  }
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const result = await runAiTransform({
      action: parsed.data.action,
      instructions: parsed.data.instructions,
      content: parsed.data.content,
      tone: (parsed.data.tone || gate.prefs.ai.defaultTone) as AiTone,
      redactSensitive: gate.prefs.ai.redactSensitiveContent,
      signal: controller.signal,
    });
    res.json(result);
  } catch (err) {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI request failed' });
  }
});

productivityRouter.post('/ai/smart-replies', requireAuth, async (req, res) => {
  const gate = requireAiConsent(req.auth!.id);
  if (!gate.ok) {
    res.status(gate.status).json(gate.body);
    return;
  }
  const threadId = String(req.body?.threadId || '');
  const tone = (req.body?.tone || gate.prefs.ai.defaultTone) as AiTone;
  const db = getDb();
  const msgs = db
    .prepare('SELECT from_name, from_address, received_at, body_text FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY received_at ASC')
    .all(threadId, req.auth!.id) as Array<{ from_name: string; from_address: string; received_at: string; body_text: string }>;
  if (msgs.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const transcript = msgs.map((m) => `From: ${m.from_name || m.from_address} (${m.received_at})\n${m.body_text}`).join('\n---\n');
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const out = await runAiSmartReplies({
      threadTranscript: transcript.slice(0, 18_000),
      tone,
      redactSensitive: gate.prefs.ai.redactSensitiveContent,
      signal: controller.signal,
    });
    res.json(out);
  } catch (err) {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI smart replies failed' });
  }
});

productivityRouter.post('/ai/analyze-thread', requireAuth, async (req, res) => {
  const gate = requireAiConsent(req.auth!.id);
  if (!gate.ok) {
    res.status(gate.status).json(gate.body);
    return;
  }
  const threadId = String(req.body?.threadId || '');
  const db = getDb();
  const msgs = db
    .prepare('SELECT from_name, from_address, received_at, subject, body_text FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY received_at ASC')
    .all(threadId, req.auth!.id) as Array<{
    from_name: string;
    from_address: string;
    received_at: string;
    subject: string;
    body_text: string;
  }>;
  if (msgs.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const transcript = msgs
    .map((m) => `Subject: ${m.subject}\nFrom: ${m.from_name || m.from_address} (${m.received_at})\n${m.body_text}`)
    .join('\n---\n');
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const out = await runAiThreadAnalysis({
      threadTranscript: transcript.slice(0, 20_000),
      redactSensitive: gate.prefs.ai.redactSensitiveContent,
      signal: controller.signal,
    });
    res.json(out);
  } catch (err) {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI thread analysis failed' });
  }
});

productivityRouter.post('/ai/translate', requireAuth, async (req, res) => {
  const gate = requireAiConsent(req.auth!.id);
  if (!gate.ok) {
    res.status(gate.status).json(gate.body);
    return;
  }
  const text = String(req.body?.text || '').trim();
  const targetLanguage = String(req.body?.targetLanguage || gate.prefs.ai.defaultTargetLanguage);
  if (!text) {
    res.status(400).json({ error: 'Text to translate is required' });
    return;
  }
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const out = await runAiTranslate({
      text: text.slice(0, 15_000),
      targetLanguage,
      redactSensitive: gate.prefs.ai.redactSensitiveContent,
      signal: controller.signal,
    });
    res.json(out);
  } catch (err) {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI translation failed' });
  }
});

productivityRouter.post('/ai/search', requireAuth, async (req, res) => {
  const prompt = String(req.body?.query || '').trim();
  const accountId = req.body?.accountId ? String(req.body.accountId) : undefined;
  if (!prompt) {
    res.status(400).json({ error: 'Search question or prompt is required' });
    return;
  }

  const prefs = getUserPreferences(req.auth!.id);
  const db = getDb();
  const queryUsed = deriveSearchQueryFromNaturalLanguage(prompt) || prompt;
  const searchRes = executeSearch(db, req.auth!.id, queryUsed, { accountId, limit: 15 });
  const threads = hydrateThreadList(db, req.auth!.id, searchRes.threadIds);

  const snippets = threads.slice(0, 8).map((t: any) => ({
    threadId: t.id,
    subject: t.subject,
    from: t.participants?.[0]?.name || t.participants?.[0]?.address || t.accountEmail,
    receivedAt: t.lastMessageAt,
    snippet: t.snippet,
  }));

  const canUseLlm = prefs.ai.enabled && prefs.ai.privacyDisclosureAccepted && getAiProviderStatus().configured;
  if (!canUseLlm) {
    res.json({
      queryUsed,
      threads,
      usedLlm: false,
      answer:
        threads.length > 0
          ? `Matched ${threads.length} conversation(s) via local FTS5 query "${queryUsed}". Enable AI with a server API key for generative narrative synthesis.`
          : `No permitted conversations matched "${queryUsed}".`,
    });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const synth = await synthesizeAiSearchAnswer({
      prompt,
      snippets,
      redactSensitive: prefs.ai.redactSensitiveContent,
      signal: controller.signal,
    });
    res.json({
      queryUsed,
      threads,
      answer: synth.answer,
      usedLlm: synth.usedLlm,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI search failed' });
  }
});

productivityRouter.get('/ai/workflow/history', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM ai_workflow_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(req.auth!.id) as Array<Record<string, any>>;
  res.json({
    runs: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      workflowType: r.workflow_type,
      prompt: r.prompt,
      plan: JSON.parse(r.plan_json || '[]'),
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    })),
  });
});

productivityRouter.post('/ai/workflow/plan', requireAuth, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const workflowType = String(req.body?.workflowType || 'summarize_and_tasks');
  const threadId = req.body?.threadId ? String(req.body.threadId) : null;
  if (!prompt) {
    res.status(400).json({ error: 'Workflow instruction is required' });
    return;
  }

  const db = getDb();
  const prefs = getUserPreferences(req.auth!.id);
  let thread: { id: string; subject: string; account_id: string } | null = null;
  let msgs: Array<{ id: string; from_name: string; from_address: string; subject: string; body_text: string }> = [];

  if (threadId) {
    thread =
      (db.prepare('SELECT id, subject, account_id FROM threads WHERE id = ? AND user_id = ?').get(threadId, req.auth!.id) as
        | { id: string; subject: string; account_id: string }
        | undefined) || null;
    if (!thread) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    msgs = db
      .prepare('SELECT id, from_name, from_address, subject, body_text FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY received_at ASC')
      .all(thread.id, req.auth!.id) as typeof msgs;
  }

  const allowLlm = prefs.ai.enabled && prefs.ai.privacyDisclosureAccepted && getAiProviderStatus().configured;
  const planned = await planAiWorkflowSteps({
    prompt,
    workflowType,
    thread: thread ? { id: thread.id, subject: thread.subject, accountId: thread.account_id } : null,
    messages: msgs.map((m) => ({
      id: m.id,
      fromName: m.from_name,
      fromAddress: m.from_address,
      subject: m.subject,
      bodyText: m.body_text,
    })),
    redactSensitive: prefs.ai.redactSensitiveContent,
    allowLlm,
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_workflow_runs (id, user_id, thread_id, workflow_type, prompt, plan_json, actions_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'awaiting_confirmation', ?)`
  ).run(id, req.auth!.id, threadId, workflowType, prompt, JSON.stringify(planned.steps), now);

  res.status(201).json({
    run: {
      id,
      threadId,
      workflowType,
      prompt,
      plan: planned.steps,
      status: 'awaiting_confirmation',
      usedLlm: planned.usedLlm,
      createdAt: now,
    },
  });
});

productivityRouter.post('/ai/workflow/:id/execute', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const run = db.prepare('SELECT * FROM ai_workflow_runs WHERE id = ? AND user_id = ?').get(param(req, 'id'), userId) as
    | Record<string, any>
    | undefined;
  if (!run) {
    res.status(404).json({ error: 'Workflow run not found' });
    return;
  }
  if (run.status !== 'awaiting_confirmation') {
    res.status(400).json({ error: `Workflow is already ${run.status}` });
    return;
  }

  const steps = JSON.parse(run.plan_json || '[]') as Array<{
    stepType: string;
    title: string;
    payload: Record<string, any>;
  }>;
  const now = new Date().toISOString();
  const executed: Array<{ stepType: string; createdId?: string; detail: string }> = [];

  try {
    for (const s of steps) {
      if (s.stepType === 'create_task') {
        const taskId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO tasks (id, user_id, title, notes, status, priority, category, due_at, thread_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'todo', ?, 'AI Workflow', ?, ?, ?, ?)`
        ).run(
          taskId,
          userId,
          String(s.payload?.title || s.title || 'Follow-up Task').slice(0, 180),
          `Created by confirmed AI workflow: ${run.prompt}`,
          ['low', 'medium', 'high', 'urgent'].includes(String(s.payload?.priority)) ? String(s.payload.priority) : 'medium',
          s.payload?.dueAt || null,
          run.thread_id || null,
          now,
          now
        );
        executed.push({ stepType: 'create_task', createdId: taskId, detail: s.title });
      } else if (s.stepType === 'create_reminder') {
        const remId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO reminders (id, user_id, thread_id, title, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
        ).run(
          remId,
          userId,
          run.thread_id || null,
          String(s.payload?.title || s.title || 'Reminder').slice(0, 180),
          s.payload?.dueAt || new Date(Date.now() + 86_400_000).toISOString(),
          now
        );
        executed.push({ stepType: 'create_reminder', createdId: remId, detail: s.title });
      } else if (s.stepType === 'create_event') {
        const evId = crypto.randomUUID();
        const startAt = s.payload?.startAt || new Date(Date.now() + 86_400_000).toISOString();
        const endAt = s.payload?.endAt || new Date(new Date(startAt).getTime() + 3600_000).toISOString();
        db.prepare(
          `INSERT INTO calendar_events (
            id, user_id, thread_id, title, description, location, start_at, end_at, all_day, timezone, status, attendees_json, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'UTC', 'confirmed', '[]', 'extracted', ?, ?)`
        ).run(
          evId,
          userId,
          run.thread_id || null,
          String(s.payload?.title || s.title || 'Meeting').slice(0, 180),
          String(s.payload?.description || ''),
          String(s.payload?.location || ''),
          startAt,
          endAt,
          now,
          now
        );
        executed.push({ stepType: 'create_event', createdId: evId, detail: s.title });
      } else if (s.stepType === 'create_draft' && run.thread_id) {
        const threadRow = db
          .prepare('SELECT id, account_id, subject FROM threads WHERE id = ? AND user_id = ?')
          .get(run.thread_id, userId) as { id: string; account_id: string; subject: string } | undefined;
        const lastMsg = db
          .prepare('SELECT id, from_name, from_address FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY received_at DESC LIMIT 1')
          .get(run.thread_id, userId) as { id: string; from_name: string; from_address: string } | undefined;
        if (threadRow && lastMsg) {
          const draftId = crypto.randomUUID();
          const bodyText = String(s.payload?.bodyText || '');
          const bodyHtml = `<p>${bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
          db.prepare(
            `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, mode, to_json, cc_json, bcc_json, subject, body_html, body_text, is_plain_text, status, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'reply', ?, '[]', '[]', ?, ?, ?, 0, 'draft', 1, ?, ?)`
          ).run(
            draftId,
            userId,
            threadRow.account_id,
            threadRow.id,
            lastMsg.id,
            JSON.stringify([{ name: lastMsg.from_name, address: lastMsg.from_address }]),
            threadRow.subject.toLowerCase().startsWith('re:') ? threadRow.subject : `Re: ${threadRow.subject}`,
            bodyHtml,
            bodyText,
            now,
            now
          );
          executed.push({ stepType: 'create_draft', createdId: draftId, detail: s.title });
        }
      } else if (s.stepType === 'organize_thread' && run.thread_id) {
        const act = String(s.payload?.action || 'star');
        if (act === 'star') db.prepare('UPDATE threads SET is_starred = 1 WHERE id = ? AND user_id = ?').run(run.thread_id, userId);
        if (act === 'mark_read') db.prepare('UPDATE threads SET unread_count = 0 WHERE id = ? AND user_id = ?').run(run.thread_id, userId);
        executed.push({ stepType: 'organize_thread', detail: s.title });
      }
    }

    db.prepare("UPDATE ai_workflow_runs SET status = 'executed', actions_json = ?, completed_at = ? WHERE id = ?").run(
      JSON.stringify(executed),
      now,
      run.id
    );
    res.json({ ok: true, executed });
  } catch (err) {
    db.prepare("UPDATE ai_workflow_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").run(
      err instanceof Error ? err.message : 'Workflow execution failed',
      now,
      run.id
    );
    res.status(500).json({ error: 'Workflow execution failed' });
  }
});

productivityRouter.post('/ai/workflow/:id/cancel', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE ai_workflow_runs SET status = 'cancelled', completed_at = ? WHERE id = ? AND user_id = ? AND status = 'awaiting_confirmation'").run(
    new Date().toISOString(),
    param(req, 'id'),
    req.auth!.id
  );
  res.json({ ok: true });
});

// --- EXPLICIT STARTER WORKSPACE DATA SEEDER ---
productivityRouter.post('/workspace/seed-sample', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const requestedAccountId = req.body?.accountId ? String(req.body.accountId) : null;
  const account = requestedAccountId
    ? (db
        .prepare("SELECT id, email_address, display_name FROM accounts WHERE id = ? AND user_id = ? AND provider_type = 'local'")
        .get(requestedAccountId, userId) as { id: string; email_address: string; display_name: string } | undefined)
    : (db
        .prepare("SELECT id, email_address, display_name FROM accounts WHERE user_id = ? AND provider_type = 'local' LIMIT 1")
        .get(userId) as { id: string; email_address: string; display_name: string } | undefined);

  if (!account) {
    res.status(400).json({ error: 'Create or select a Local Workspace mailbox first to seed sample correspondence' });
    return;
  }

  const out = seedStarterCorrespondence(db, userId, account.id, account.email_address, account.display_name);
  res.json({ ok: true, ...out });
});
