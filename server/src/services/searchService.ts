import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface ParsedSearchQuery {
  from?: string;
  to?: string;
  subject?: string;
  filename?: string;
  category?: string;
  largerBytes?: number;
  smallerBytes?: number;
  hasAttachment?: boolean;
  before?: string;
  after?: string;
  isUnread?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  folder?: string;
  label?: string;
  freeTextTerms: string[];
  excludedTerms: string[];
}

function parseSizeToBytes(raw: string): number | undefined {
  const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|k|mb|m|gb|g)?$/);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) return undefined;
  const unit = match[2] || 'b';
  if (unit === 'kb' || unit === 'k') return Math.round(num * 1024);
  if (unit === 'mb' || unit === 'm') return Math.round(num * 1024 * 1024);
  if (unit === 'gb' || unit === 'g') return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num);
}

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = {
    freeTextTerms: [],
    excludedTerms: [],
  };
  const tokenRegex = /(-?[a-z]+:"[^"]+"|-?[a-z]+:\S+|"[^"]+"|\S+)/gi;
  const tokens = rawQuery.match(tokenRegex) || [];

  for (const rawToken of tokens) {
    const colonIdx = rawToken.indexOf(':');
    if (colonIdx > 0 && !rawToken.startsWith('"')) {
      const op = rawToken.slice(0, colonIdx).toLowerCase();
      let val = rawToken.slice(colonIdx + 1);
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);

      switch (op) {
        case 'from':
          result.from = val;
          continue;
        case 'to':
          result.to = val;
          continue;
        case 'subject':
          result.subject = val;
          continue;
        case 'filename':
        case 'file':
          result.filename = val;
          continue;
        case 'category':
          result.category = val.toLowerCase();
          continue;
        case 'larger':
        case 'size':
          result.largerBytes = parseSizeToBytes(val);
          continue;
        case 'smaller':
          result.smallerBytes = parseSizeToBytes(val);
          continue;
        case 'has':
          if (val.toLowerCase() === 'attachment' || val.toLowerCase() === 'attachments') {
            result.hasAttachment = true;
          }
          continue;
        case 'before':
          result.before = val;
          continue;
        case 'after':
          result.after = val;
          continue;
        case 'is':
          if (val.toLowerCase() === 'unread') result.isUnread = true;
          if (val.toLowerCase() === 'read') result.isUnread = false;
          if (val.toLowerCase() === 'starred') result.isStarred = true;
          if (val.toLowerCase() === 'important') result.isImportant = true;
          continue;
        case 'in':
          result.folder = val.toLowerCase();
          continue;
        case 'label':
          result.label = val;
          continue;
      }
    }

    if (rawToken.startsWith('-') && rawToken.length > 1) {
      result.excludedTerms.push(rawToken.slice(1).replace(/^"|"$/g, ''));
    } else {
      result.freeTextTerms.push(rawToken.replace(/^"|"$/g, ''));
    }
  }
  return result;
}

function escapeFtsTerm(term: string): string {
  const clean = term.replace(/["*^():]/g, ' ').trim();
  if (!clean) return '';
  return `"${clean.replace(/"/g, '""')}"*`;
}

export function executeSearch(
  db: DatabaseSync,
  userId: string,
  queryStr: string,
  filters: {
    accountId?: string;
    folder?: string;
    labelId?: string;
    hasAttachment?: boolean;
    from?: string;
    to?: string;
    after?: string;
    before?: string;
    isUnread?: boolean;
    limit?: number;
    offset?: number;
  } = {}
) {
  const parsed = parseSearchQuery(queryStr);
  const whereClauses: string[] = ['m.user_id = ?', 'm.is_draft = 0'];
  const params: Array<string | number> = [userId];

  if (filters.accountId) {
    whereClauses.push('m.account_id = ?');
    params.push(filters.accountId);
  }

  const fromFilter = filters.from || parsed.from;
  if (fromFilter) {
    whereClauses.push('(lower(m.from_address) LIKE ? OR lower(m.from_name) LIKE ?)');
    params.push(`%${fromFilter.toLowerCase()}%`, `%${fromFilter.toLowerCase()}%`);
  }

  const toFilter = filters.to || parsed.to;
  if (toFilter) {
    whereClauses.push('(lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ? OR lower(m.bcc_json) LIKE ?)');
    params.push(`%${toFilter.toLowerCase()}%`, `%${toFilter.toLowerCase()}%`, `%${toFilter.toLowerCase()}%`);
  }

  if (parsed.subject) {
    whereClauses.push('lower(m.subject) LIKE ?');
    params.push(`%${parsed.subject.toLowerCase()}%`);
  }

  const hasAtt = filters.hasAttachment ?? parsed.hasAttachment;
  if (hasAtt) {
    whereClauses.push('m.has_attachments = 1');
  }

  if (parsed.filename) {
    whereClauses.push('EXISTS (SELECT 1 FROM attachments att WHERE att.message_id = m.id AND lower(att.filename) LIKE ?)');
    params.push(`%${parsed.filename.toLowerCase()}%`);
  }

  if (parsed.category) {
    whereClauses.push('lower(m.category_slug) = ?');
    params.push(parsed.category);
  }

  if (parsed.largerBytes !== undefined) {
    whereClauses.push('m.size_bytes >= ?');
    params.push(parsed.largerBytes);
  }

  if (parsed.smallerBytes !== undefined) {
    whereClauses.push('m.size_bytes <= ?');
    params.push(parsed.smallerBytes);
  }

  const afterDate = filters.after || parsed.after;
  if (afterDate) {
    whereClauses.push('m.received_at >= ?');
    params.push(afterDate);
  }

  const beforeDate = filters.before || parsed.before;
  if (beforeDate) {
    whereClauses.push('m.received_at <= ?');
    params.push(`${beforeDate}T23:59:59.999Z`);
  }

  const unread = filters.isUnread ?? parsed.isUnread;
  if (unread !== undefined) {
    whereClauses.push('m.is_read = ?');
    params.push(unread ? 0 : 1);
  }

  if (parsed.isStarred) {
    whereClauses.push('m.is_starred = 1');
  }

  if (parsed.isImportant) {
    whereClauses.push('m.is_important = 1');
  }

  const folderScope = filters.folder || parsed.folder;
  if (folderScope && folderScope !== 'all') {
    if (folderScope === 'inbox') whereClauses.push('t.in_inbox = 1');
    else if (folderScope === 'sent') whereClauses.push('t.in_sent = 1');
    else if (folderScope === 'archive') whereClauses.push('t.in_archive = 1');
    else if (folderScope === 'spam') whereClauses.push('m.is_spam = 1');
    else if (folderScope === 'trash') whereClauses.push('m.is_trash = 1');
    else if (folderScope === 'starred') whereClauses.push('m.is_starred = 1');
    else if (folderScope === 'important') whereClauses.push('m.is_important = 1');
    else {
      whereClauses.push('EXISTS (SELECT 1 FROM folders f WHERE f.id = m.folder_id AND (f.slug = ? OR lower(f.name) = lower(?)))');
      params.push(folderScope, folderScope);
    }
  } else if (!folderScope) {
    whereClauses.push('m.is_spam = 0 AND m.is_trash = 0');
  }

  if (filters.labelId) {
    whereClauses.push('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)');
    params.push(filters.labelId);
  } else if (parsed.label) {
    whereClauses.push(
      'EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND lower(l.name) LIKE ?)'
    );
    params.push(`%${parsed.label.toLowerCase()}%`);
  }

  for (const ex of parsed.excludedTerms) {
    whereClauses.push('(lower(m.subject) NOT LIKE ? AND lower(m.body_text) NOT LIKE ?)');
    params.push(`%${ex.toLowerCase()}%`, `%${ex.toLowerCase()}%`);
  }

  let joinClause = 'JOIN threads t ON t.id = m.thread_id';
  const ftsTerms = parsed.freeTextTerms.map(escapeFtsTerm).filter(Boolean);
  if (ftsTerms.length > 0) {
    joinClause += ' JOIN messages_fts fts ON fts.message_id = m.id';
    whereClauses.push('messages_fts MATCH ?');
    params.push(ftsTerms.join(' AND '));
  }

  const limit = Math.min(filters.limit || 50, 100);
  const offset = filters.offset || 0;

  const sql = `
    SELECT DISTINCT t.id AS thread_id
    FROM messages m
    ${joinClause}
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY t.last_message_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const threadIdRows = db.prepare(sql).all(...params) as Array<{ thread_id: string }>;

  if (queryStr.trim().length >= 2) {
    db.prepare('DELETE FROM search_history WHERE user_id = ? AND query = ?').run(userId, queryStr.trim());
    db.prepare('INSERT INTO search_history (id, user_id, query, created_at) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(),
      userId,
      queryStr.trim(),
      new Date().toISOString()
    );
  }

  return {
    threadIds: threadIdRows.map((r) => r.thread_id),
    parsed,
    highlightTerms: parsed.freeTextTerms.concat(parsed.subject ? [parsed.subject] : []),
  };
}
