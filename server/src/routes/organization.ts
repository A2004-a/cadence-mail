import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import {
  applyRuleActionsToMessage,
  doesRuleMatch,
  previewRuleMatches,
  type EvaluableMessage,
} from '../services/ruleEngine.js';
import { executeSearch } from '../services/searchService.js';
import { eventBus } from '../services/eventBus.js';
import { getOrCreateFolderByRole, ingestMessage, recomputeThreadState } from '../services/threadService.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { ProviderCredentials } from '../providers/types.js';
import { decryptSecret } from '../security/crypto.js';
import type { ProviderType } from '../types.js';
import { hydrateThreadList } from './threads.js';

export const organizationRouter = Router();

// --- FOLDERS ---
organizationRouter.get('/folders', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(DISTINCT m.thread_id)
               FROM messages m
               WHERE m.folder_id = f.id AND m.is_read = 0 AND m.is_draft = 0) AS unread_count
       FROM folders f
       WHERE f.user_id = ?
       ORDER BY f.sort_order ASC, f.name ASC`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    folders: rows.map((f) => ({
      id: f.id,
      accountId: f.account_id,
      name: f.name,
      slug: f.slug,
      systemRole: f.system_role,
      parentId: f.parent_id,
      color: f.color,
      sortOrder: f.sort_order,
      isFavorite: Boolean(f.is_favorite),
      unreadCount: f.unread_count || 0,
    })),
  });
});

const createFolderSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  parentId: z.string().nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#475569'),
  isFavorite: z.boolean().default(false),
});

organizationRouter.post('/folders', requireAuth, (req, res) => {
  const parsed = createFolderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid folder details' });
    return;
  }

  const db = getDb();
  const userId = req.auth!.id;
  const acct = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(parsed.data.accountId, userId);
  if (!acct) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  const baseSlug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'folder';
  const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 4)}`;
  const id = crypto.randomUUID();
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 10) AS mx FROM folders WHERE account_id = ?')
    .get(parsed.data.accountId) as { mx: number };

  db.prepare(
    `INSERT INTO folders (id, account_id, user_id, remote_id, name, slug, system_role, parent_id, color, sort_order, is_favorite, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'custom', ?, ?, ?, ?, ?)`
  ).run(
    id,
    parsed.data.accountId,
    userId,
    parsed.data.name,
    slug,
    parsed.data.parentId || null,
    parsed.data.color,
    maxOrder.mx + 1,
    parsed.data.isFavorite ? 1 : 0,
    new Date().toISOString()
  );

  res.status(201).json({
    folder: {
      id,
      accountId: parsed.data.accountId,
      name: parsed.data.name,
      slug,
      systemRole: 'custom',
      parentId: parsed.data.parentId || null,
      color: parsed.data.color,
      sortOrder: maxOrder.mx + 1,
      isFavorite: parsed.data.isFavorite,
      unreadCount: 0,
    },
  });
});

const patchFolderSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.number().int().optional(),
  isFavorite: z.boolean().optional(),
  parentId: z.string().nullable().optional(),
});

organizationRouter.patch('/folders/:id', requireAuth, (req, res) => {
  const parsed = patchFolderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid folder update' });
    return;
  }
  const db = getDb();
  const folder = db
    .prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as Record<string, any> | undefined;
  if (!folder) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }

  const d = parsed.data;
  db.prepare('UPDATE folders SET name = ?, color = ?, sort_order = ?, is_favorite = ?, parent_id = ? WHERE id = ?').run(
    folder.system_role === 'custom' && d.name ? d.name : folder.name,
    d.color ?? folder.color,
    d.sortOrder ?? folder.sort_order,
    d.isFavorite !== undefined ? (d.isFavorite ? 1 : 0) : folder.is_favorite,
    d.parentId !== undefined ? d.parentId : folder.parent_id,
    folder.id
  );
  res.json({ ok: true });
});

organizationRouter.delete('/folders/:id', requireAuth, (req, res) => {
  const db = getDb();
  const folder = db
    .prepare('SELECT id, account_id, system_role FROM folders WHERE id = ? AND user_id = ?')
    .get(param(req, 'id'), req.auth!.id) as { id: string; account_id: string; system_role: string } | undefined;
  if (!folder) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }
  if (folder.system_role !== 'custom') {
    res.status(400).json({ error: 'System folders cannot be deleted' });
    return;
  }

  const inboxId = getOrCreateFolderByRole(db, req.auth!.id, folder.account_id, 'inbox');
  const affectedThreads = db
    .prepare('SELECT DISTINCT thread_id FROM messages WHERE folder_id = ?')
    .all(folder.id) as Array<{ thread_id: string }>;
  db.prepare('UPDATE messages SET folder_id = ? WHERE folder_id = ?').run(inboxId, folder.id);
  db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  for (const t of affectedThreads) recomputeThreadState(db, t.thread_id);
  res.json({ ok: true });
});

// --- LABELS ---
organizationRouter.get('/labels', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT l.*,
              (SELECT COUNT(DISTINCT m.thread_id)
               FROM message_labels ml JOIN messages m ON m.id = ml.message_id
               WHERE ml.label_id = l.id AND m.is_trash = 0 AND m.is_spam = 0) AS thread_count
       FROM labels l
       WHERE l.user_id = ?
       ORDER BY l.sort_order ASC, l.name ASC`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    labels: rows.map((l) => ({
      id: l.id,
      accountId: l.account_id,
      name: l.name,
      color: l.color,
      sortOrder: l.sort_order,
      isFavorite: Boolean(l.is_favorite),
      threadCount: l.thread_count || 0,
    })),
  });
});

const labelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563EB'),
  isFavorite: z.boolean().default(false),
});

organizationRouter.post('/labels', requireAuth, (req, res) => {
  const parsed = labelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid label details' });
    return;
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const maxOrd = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM labels WHERE user_id = ?')
    .get(req.auth!.id) as { mx: number };

  db.prepare(
    'INSERT INTO labels (id, user_id, account_id, name, color, sort_order, is_favorite, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
  ).run(
    id,
    req.auth!.id,
    parsed.data.name,
    parsed.data.color,
    maxOrd.mx + 1,
    parsed.data.isFavorite ? 1 : 0,
    new Date().toISOString()
  );

  res.status(201).json({
    label: {
      id,
      accountId: null,
      name: parsed.data.name,
      color: parsed.data.color,
      sortOrder: maxOrd.mx + 1,
      isFavorite: parsed.data.isFavorite,
      threadCount: 0,
    },
  });
});

organizationRouter.patch('/labels/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM labels WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | Record<string, any>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Label not found' });
    return;
  }
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : existing.name;
  const color = typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : existing.color;
  const sortOrder = typeof req.body?.sortOrder === 'number' ? req.body.sortOrder : existing.sort_order;
  const isFavorite = typeof req.body?.isFavorite === 'boolean' ? (req.body.isFavorite ? 1 : 0) : existing.is_favorite;

  db.prepare('UPDATE labels SET name = ?, color = ?, sort_order = ?, is_favorite = ? WHERE id = ?').run(
    name,
    color,
    sortOrder,
    isFavorite,
    existing.id
  );
  res.json({ ok: true });
});

organizationRouter.delete('/labels/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM labels WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- CATEGORIES ---
organizationRouter.get('/categories', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order ASC')
    .all(req.auth!.id) as Array<Record<string, any>>;
  res.json({
    categories: rows.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      color: c.color,
      enabled: Boolean(c.enabled),
      sortOrder: c.sort_order,
      description: c.description,
    })),
  });
});

organizationRouter.post('/categories', requireAuth, (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563EB'),
    description: z.string().max(160).default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid category name and hex color required' });
    return;
  }
  const db = getDb();
  const baseSlug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
  const existing = db.prepare('SELECT id FROM categories WHERE user_id = ? AND slug = ?').get(req.auth!.id, baseSlug);
  const slug = existing ? `${baseSlug}-${crypto.randomUUID().slice(0, 4)}` : baseSlug;
  const maxOrd = db.prepare('SELECT COALESCE(MAX(sort_order), 10) AS mx FROM categories WHERE user_id = ?').get(req.auth!.id) as { mx: number };
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO categories (id, user_id, slug, name, color, enabled, sort_order, description) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
    id,
    req.auth!.id,
    slug,
    parsed.data.name,
    parsed.data.color,
    maxOrd.mx + 1,
    parsed.data.description
  );
  res.status(201).json({
    category: {
      id,
      slug,
      name: parsed.data.name,
      color: parsed.data.color,
      enabled: true,
      sortOrder: maxOrd.mx + 1,
      description: parsed.data.description,
    },
  });
});

organizationRouter.patch('/categories/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | Record<string, any>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  db.prepare('UPDATE categories SET name = ?, color = ?, enabled = ?, sort_order = ? WHERE id = ?').run(
    typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : existing.name,
    typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : existing.color,
    typeof req.body?.enabled === 'boolean' ? (req.body.enabled ? 1 : 0) : existing.enabled,
    typeof req.body?.sortOrder === 'number' ? req.body.sortOrder : existing.sort_order,
    existing.id
  );
  res.json({ ok: true });
});

organizationRouter.delete('/categories/:id', requireAuth, (req, res) => {
  const db = getDb();
  const cat = db.prepare('SELECT id, slug FROM categories WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | { id: string; slug: string }
    | undefined;
  if (!cat) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  if (cat.slug === 'primary') {
    res.status(400).json({ error: 'Primary category cannot be deleted' });
    return;
  }
  db.prepare("UPDATE messages SET category_slug = 'primary' WHERE user_id = ? AND category_slug = ?").run(req.auth!.id, cat.slug);
  db.prepare("UPDATE threads SET category_slug = 'primary' WHERE user_id = ? AND category_slug = ?").run(req.auth!.id, cat.slug);
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  res.json({ ok: true });
});

// --- SEARCH ---
organizationRouter.get('/search', requireAuth, async (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '');
  const targetAccountId = req.query.accountId ? String(req.query.accountId) : undefined;
  const includeRemote = req.query.remote === 'true' || req.query.includeRemote === 'true';

  const accounts = db
    .prepare(
      `SELECT id, provider_type, account_ownership, email_address, status, capabilities_json, encrypted_credentials
       FROM accounts WHERE user_id = ? ${targetAccountId ? 'AND id = ?' : ''}`
    )
    .all(...(targetAccountId ? [req.auth!.id, targetAccountId] : [req.auth!.id])) as Array<{
    id: string;
    provider_type: ProviderType;
    account_ownership: string;
    email_address: string;
    status: string;
    capabilities_json: string;
    encrypted_credentials: string;
  }>;

  const accountStatuses: Array<{
    accountId: string;
    emailAddress: string;
    providerType: string;
    ownership: string;
    scope: 'local_index' | 'remote_merged';
    status: 'ok' | 'disconnected' | 'failed';
    remoteMatches: number;
    error?: string;
  }> = [];

  for (const acct of accounts) {
    const caps = JSON.parse(acct.capabilities_json || '{}');
    if (acct.account_ownership === 'hosted' || acct.provider_type === 'hosted' || acct.provider_type === 'local') {
      accountStatuses.push({
        accountId: acct.id,
        emailAddress: acct.email_address,
        providerType: acct.provider_type,
        ownership: 'hosted',
        scope: 'local_index',
        status: 'ok',
        remoteMatches: 0,
      });
      continue;
    }

    if (acct.status === 'disconnected' || acct.status === 'auth_expired') {
      accountStatuses.push({
        accountId: acct.id,
        emailAddress: acct.email_address,
        providerType: acct.provider_type,
        ownership: 'external',
        scope: 'local_index',
        status: 'disconnected',
        remoteMatches: 0,
        error: acct.status === 'auth_expired' ? 'Authorization expired; searching cached local index only.' : 'Disconnected',
      });
      continue;
    }

    if (includeRemote && q.trim() && caps.supportsRemoteSearch) {
      try {
        const adapter = getProviderAdapter(acct.provider_type);
        if (adapter.searchRemote) {
          const creds = JSON.parse(decryptSecret(acct.encrypted_credentials)) as ProviderCredentials;
          const remoteHits = await adapter.searchRemote(creds, q.trim());
          let imported = 0;
          for (const payload of remoteHits) {
            const ins = ingestMessage(db, req.auth!.id, acct.id, payload, { skipNotifications: true, skipRules: true });
            if (ins.inserted) imported += 1;
          }
          accountStatuses.push({
            accountId: acct.id,
            emailAddress: acct.email_address,
            providerType: acct.provider_type,
            ownership: 'external',
            scope: 'remote_merged',
            status: 'ok',
            remoteMatches: remoteHits.length || imported,
          });
          continue;
        }
      } catch (err) {
        accountStatuses.push({
          accountId: acct.id,
          emailAddress: acct.email_address,
          providerType: acct.provider_type,
          ownership: 'external',
          scope: 'local_index',
          status: 'failed',
          remoteMatches: 0,
          error: err instanceof Error ? err.message : 'Remote provider search failed; showing cached index only.',
        });
        continue;
      }
    }

    accountStatuses.push({
      accountId: acct.id,
      emailAddress: acct.email_address,
      providerType: acct.provider_type,
      ownership: 'external',
      scope: 'local_index',
      status: 'ok',
      remoteMatches: 0,
    });
  }

  const result = executeSearch(db, req.auth!.id, q, {
    accountId: targetAccountId,
    folder: req.query.folder ? String(req.query.folder) : undefined,
    labelId: req.query.labelId ? String(req.query.labelId) : undefined,
    hasAttachment: req.query.hasAttachment === 'true' ? true : undefined,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    after: req.query.after ? String(req.query.after) : undefined,
    before: req.query.before ? String(req.query.before) : undefined,
    isUnread: req.query.isUnread === 'true' ? true : undefined,
    limit: req.query.limit ? Number(req.query.limit) : 50,
    offset: req.query.offset ? Number(req.query.offset) : 0,
  });

  const threads = hydrateThreadList(db, req.auth!.id, result.threadIds);
  res.json({
    threads,
    parsed: result.parsed,
    highlightTerms: result.highlightTerms,
    searchMeta: {
      scope: includeRemote ? 'hybrid_local_and_remote' : 'local_fts5_and_cache',
      remoteQueried: includeRemote,
      hasPartialFailures: accountStatuses.some((s) => s.status !== 'ok'),
      accountStatuses,
    },
  });
});

organizationRouter.get('/search/history', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, query, created_at FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 12')
    .all(req.auth!.id);
  res.json({ history: rows });
});

organizationRouter.delete('/search/history', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM search_history WHERE user_id = ?').run(req.auth!.id);
  res.json({ ok: true });
});

// --- SAVED SEARCHES ---
organizationRouter.get('/saved-searches', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, account_id, name, query, created_at, updated_at FROM saved_searches WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.auth!.id) as Array<Record<string, any>>;
  res.json({
    savedSearches: rows.map((s) => ({
      id: s.id,
      accountId: s.account_id,
      name: s.name,
      query: s.query,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    })),
  });
});

organizationRouter.post('/saved-searches', requireAuth, (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(60),
    query: z.string().trim().min(1).max(400),
    accountId: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Name and search query are required' });
    return;
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO saved_searches (id, user_id, account_id, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.auth!.id, parsed.data.accountId || null, parsed.data.name, parsed.data.query, now, now);
  res.status(201).json({
    savedSearch: {
      id,
      accountId: parsed.data.accountId || null,
      name: parsed.data.name,
      query: parsed.data.query,
      createdAt: now,
      updatedAt: now,
    },
  });
});

organizationRouter.delete('/saved-searches/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- RULES ---
const conditionSchema = z.object({
  field: z.enum([
    'from',
    'to',
    'subject',
    'body',
    'keywords',
    'domain',
    'has_attachment',
    'date_after',
    'date_before',
    'label',
    'category',
    'is_read',
    'is_starred',
    'is_important',
  ]),
  operator: z.enum([
    'contains',
    'contains_any',
    'regex',
    'not_contains',
    'equals',
    'starts_with',
    'ends_with',
    'is_true',
    'is_false',
    'after',
    'before',
  ]),
  value: z.string().default(''),
});

const actionSchema = z.object({
  type: z.enum([
    'move_to_folder',
    'apply_label',
    'mark_read',
    'mark_unread',
    'mark_important',
    'archive',
    'star',
    'skip_inbox',
    'notify',
    'categorize',
    'forward',
    'create_task',
    'create_reminder',
    'create_event',
    'generate_draft',
    'auto_reply',
  ]),
  value: z.string().optional(),
  subject: z.string().max(480).optional(),
  attachmentIds: z.array(z.string().min(1)).max(20).optional(),
  infoProfileIds: z.array(z.string().min(1)).max(20).optional(),
  includeOriginalAttachments: z.boolean().optional(),
});

const ruleSchema = z.object({
  accountId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  priorityOrder: z.number().int().optional(),
  matchMode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).min(1),
  actions: z.array(actionSchema).min(1),
  stopProcessing: z.boolean().default(false),
});

organizationRouter.get('/rules', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY priority_order ASC, created_at ASC')
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    rules: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      name: r.name,
      enabled: Boolean(r.enabled),
      priorityOrder: r.priority_order,
      matchMode: r.match_mode,
      conditions: JSON.parse(r.conditions_json),
      actions: JSON.parse(r.actions_json),
      stopProcessing: Boolean(r.stop_processing),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

organizationRouter.post('/rules/preview', requireAuth, (req, res) => {
  const parsed = z
    .object({
      accountId: z.string().nullable().optional(),
      matchMode: z.enum(['all', 'any']).default('all'),
      conditions: z.array(conditionSchema).min(1),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid preview conditions' });
    return;
  }
  const db = getDb();
  const matches = previewRuleMatches(
    db,
    req.auth!.id,
    parsed.data.accountId || null,
    parsed.data.matchMode,
    parsed.data.conditions
  );
  res.json({ matchCount: matches.length, matches: matches.slice(0, 25) });
});

organizationRouter.post('/rules', requireAuth, (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid rule definition', details: parsed.error.flatten() });
    return;
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const maxOrd = db
    .prepare('SELECT COALESCE(MAX(priority_order), 0) AS mx FROM rules WHERE user_id = ?')
    .get(req.auth!.id) as { mx: number };

  db.prepare(
    `INSERT INTO rules (id, user_id, account_id, name, enabled, priority_order, match_mode, conditions_json, actions_json, stop_processing, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.auth!.id,
    parsed.data.accountId || null,
    parsed.data.name,
    parsed.data.enabled ? 1 : 0,
    maxOrd.mx + 1,
    parsed.data.matchMode,
    JSON.stringify(parsed.data.conditions),
    JSON.stringify(parsed.data.actions),
    parsed.data.stopProcessing ? 1 : 0,
    now,
    now
  );
  res.status(201).json({ id });
});

organizationRouter.patch('/rules/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM rules WHERE id = ? AND user_id = ?').get(param(req, 'id'), req.auth!.id) as
    | Record<string, any>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid rule update' });
    return;
  }

  const d = parsed.data;
  db.prepare(
    `UPDATE rules SET name = ?, enabled = ?, priority_order = ?, match_mode = ?, conditions_json = ?, actions_json = ?, stop_processing = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    d.name ?? existing.name,
    d.enabled !== undefined ? (d.enabled ? 1 : 0) : existing.enabled,
    d.priorityOrder ?? existing.priority_order,
    d.matchMode ?? existing.match_mode,
    d.conditions ? JSON.stringify(d.conditions) : existing.conditions_json,
    d.actions ? JSON.stringify(d.actions) : existing.actions_json,
    d.stopProcessing !== undefined ? (d.stopProcessing ? 1 : 0) : existing.stop_processing,
    new Date().toISOString(),
    existing.id,
    req.auth!.id
  );
  res.json({ ok: true });
});

organizationRouter.post('/rules/reorder', requireAuth, (req, res) => {
  const orderedIds = Array.isArray(req.body?.ruleIds) ? (req.body.ruleIds as string[]) : [];
  const db = getDb();
  const stmt = db.prepare('UPDATE rules SET priority_order = ?, updated_at = ? WHERE id = ? AND user_id = ?');
  const now = new Date().toISOString();
  orderedIds.forEach((id, index) => {
    stmt.run(index + 1, now, id, req.auth!.id);
  });
  res.json({ ok: true });
});

organizationRouter.post('/rules/:id/run', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.auth!.id;
  const ruleRow = db.prepare('SELECT * FROM rules WHERE id = ? AND user_id = ?').get(param(req, 'id'), userId) as
    | Record<string, any>
    | undefined;
  if (!ruleRow) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  const conditions = JSON.parse(ruleRow.conditions_json);
  const actions = JSON.parse(ruleRow.actions_json);
  const rows = db
    .prepare(
      `SELECT id, account_id, thread_id, from_name, from_address, to_json, cc_json, subject, body_text, has_attachments, received_at, category_slug, is_read, is_starred, is_important, raw_headers_json
       FROM messages
       WHERE user_id = ? AND is_draft = 0 AND is_trash = 0 AND (? IS NULL OR account_id = ?)`
    )
    .all(userId, ruleRow.account_id, ruleRow.account_id) as Array<Record<string, any>>;

  const labelStmt = db.prepare('SELECT label_id FROM message_labels WHERE message_id = ?');
  let appliedCount = 0;
  let createdTasks = false;
  let createdEvents = false;
  const touchedThreads = new Set<string>();

  for (const r of rows) {
    const labelRows = labelStmt.all(r.id) as Array<{ label_id: string }>;
    let rawHeaders: Record<string, string | string[]> | undefined;
    if (r.raw_headers_json) {
      try {
        rawHeaders = JSON.parse(r.raw_headers_json);
      } catch {
        // ignore malformed headers json
      }
    }
    const evalMsg: EvaluableMessage = {
      id: r.id,
      accountId: r.account_id,
      threadId: r.thread_id,
      fromName: r.from_name,
      fromAddress: r.from_address,
      to: JSON.parse(r.to_json || '[]'),
      cc: JSON.parse(r.cc_json || '[]'),
      subject: r.subject,
      bodyText: r.body_text,
      hasAttachments: Boolean(r.has_attachments),
      receivedAt: r.received_at,
      labelIds: labelRows.map((l) => l.label_id),
      categorySlug: r.category_slug,
      isRead: Boolean(r.is_read),
      isStarred: Boolean(r.is_starred),
      isImportant: Boolean(r.is_important),
      rawHeaders,
    };
    if (doesRuleMatch(ruleRow.match_mode, conditions, evalMsg)) {
      const outcome = applyRuleActionsToMessage(db, userId, evalMsg, actions, ruleRow.name, ruleRow.id);
      if (outcome.createdTask) createdTasks = true;
      if (outcome.createdEvent) createdEvents = true;
      if (!outcome.skippedByGuard) {
        touchedThreads.add(r.thread_id);
        appliedCount += 1;
      }
    }
  }

  for (const tid of touchedThreads) recomputeThreadState(db, tid);
  if (createdTasks) eventBus.emit(userId, 'task_updated', { ruleId: ruleRow.id });
  if (createdEvents) eventBus.emit(userId, 'calendar_updated', { ruleId: ruleRow.id });
  res.json({ ok: true, appliedCount });
});

organizationRouter.get('/rules/logs', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT l.id, l.rule_id, r.name AS rule_name, l.message_id, l.thread_id, l.status, l.detail, l.executed_at
       FROM rule_execution_logs l
       JOIN rules r ON r.id = l.rule_id
       WHERE l.user_id = ?
       ORDER BY l.executed_at DESC
       LIMIT 100`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    logs: rows.map((l) => ({
      id: l.id,
      ruleId: l.rule_id,
      ruleName: l.rule_name,
      messageId: l.message_id,
      threadId: l.thread_id,
      status: l.status,
      detail: l.detail,
      executedAt: l.executed_at,
    })),
  });
});

organizationRouter.delete('/rules/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM rules WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});

// --- BLOCKED SENDERS ---
organizationRouter.get('/blocked-senders', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, email_or_domain, created_at FROM blocked_senders WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.auth!.id);
  res.json({ blockedSenders: rows });
});

organizationRouter.delete('/blocked-senders/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM blocked_senders WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  res.json({ ok: true });
});
