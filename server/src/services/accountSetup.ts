import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getProviderCapabilities } from '../providers/registry.js';
import { DEFAULT_USER_PREFERENCES, type ProviderType, type SystemFolderRole } from '../types.js';
import { ingestMessage } from './threadService.js';

const SYSTEM_FOLDERS: Array<{ name: string; slug: string; role: SystemFolderRole; order: number; color: string }> = [
  { name: 'Inbox', slug: 'inbox', role: 'inbox', order: 1, color: '#1D4ED8' },
  { name: 'Sent', slug: 'sent', role: 'sent', order: 2, color: '#059669' },
  { name: 'Drafts', slug: 'drafts', role: 'drafts', order: 3, color: '#64748B' },
  { name: 'Archive', slug: 'archive', role: 'archive', order: 4, color: '#475569' },
  { name: 'Spam', slug: 'spam', role: 'spam', order: 5, color: '#D97706' },
  { name: 'Trash', slug: 'trash', role: 'trash', order: 6, color: '#DC2626' },
];

const DEFAULT_CATEGORIES = [
  { slug: 'primary', name: 'Primary', color: '#1D4ED8', order: 1, description: 'Direct personal & high-signal mail' },
  { slug: 'work', name: 'Work', color: '#0F766E', order: 2, description: 'Projects, engineering, and team workflows' },
  { slug: 'personal', name: 'Personal', color: '#7C3AED', order: 3, description: 'Friends, family, and personal notes' },
  { slug: 'updates', name: 'Updates', color: '#D97706', order: 4, description: 'Account notices, builds, and status changes' },
  { slug: 'notifications', name: 'Notifications', color: '#0891B2', order: 5, description: 'Automated system and app alerts' },
  { slug: 'financial', name: 'Financial', color: '#059669', order: 6, description: 'Invoices, statements, payroll, and banking' },
  { slug: 'travel', name: 'Travel', color: '#2563EB', order: 7, description: 'Flights, hotels, itineraries, and bookings' },
  { slug: 'shopping', name: 'Shopping', color: '#EA580C', order: 8, description: 'Orders, receipts, and shipment tracking' },
  { slug: 'social', name: 'Social', color: '#0284C7', order: 9, description: 'Collaborations, mentions, and networks' },
  { slug: 'promotions', name: 'Promotions', color: '#DB2777', order: 10, description: 'Offers, announcements, and campaigns' },
  { slug: 'newsletters', name: 'Newsletters', color: '#4F46E5', order: 11, description: 'Digests, publications, and briefings' },
];

export function ensureUserDefaults(db: DatabaseSync, userId: string): void {
  const now = new Date().toISOString();
  const existingPrefs = db.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?').get(userId);
  if (!existingPrefs) {
    db.prepare('INSERT INTO user_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)').run(
      userId,
      JSON.stringify(DEFAULT_USER_PREFERENCES),
      now
    );
  }

  const stmt = db.prepare(
    'INSERT OR IGNORE INTO categories (id, user_id, slug, name, color, enabled, sort_order, description) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  );
  for (const cat of DEFAULT_CATEGORIES) {
    stmt.run(crypto.randomUUID(), userId, cat.slug, cat.name, cat.color, cat.order, cat.description);
  }
}

export function createAccountFolders(db: DatabaseSync, userId: string, accountId: string): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO folders (id, account_id, user_id, remote_id, name, slug, system_role, color, sort_order, is_favorite, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  );
  for (const f of SYSTEM_FOLDERS) {
    stmt.run(crypto.randomUUID(), accountId, userId, f.slug, f.name, f.slug, f.role, f.color, f.order, now);
  }
}

export function createHostedAccountForUser(
  db: DatabaseSync,
  userId: string,
  emailAddress: string,
  displayName: string,
  opts: { domainId?: string | null; quotaMb?: number; isDefault?: boolean; providerType?: 'hosted' | 'local' } = {}
): string {
  const accountId = crypto.randomUUID();
  const now = new Date().toISOString();
  const pType = opts.providerType || 'hosted';
  const capabilities = getProviderCapabilities(pType as ProviderType);

  const existingDefault = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND is_default = 1 LIMIT 1').get(userId);
  const makeDefault = opts.isDefault || !existingDefault;
  if (makeDefault) {
    db.prepare('UPDATE accounts SET is_default = 0 WHERE user_id = ?').run(userId);
  }

  db.prepare(
    `INSERT INTO accounts (
      id, user_id, provider_type, account_ownership, domain_id, email_address, display_name, avatar_color,
      signature_html, signature_enabled, status, is_default, quota_mb, used_bytes, capabilities_json,
      encrypted_credentials, sync_cursor, last_synced_at, notification_prefs_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'hosted', ?, ?, ?, ?, ?, 1, 'connected', ?, ?, 0, ?, '', ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    userId,
    pType,
    opts.domainId ?? null,
    emailAddress.toLowerCase(),
    displayName,
    pType === 'hosted' ? '#4F46E5' : '#1D4ED8',
    `<p>Best regards,<br><strong>${displayName}</strong></p>`,
    makeDefault ? 1 : 0,
    opts.quotaMb ?? 1024,
    JSON.stringify(capabilities),
    now,
    now,
    JSON.stringify({ enabled: true, importantOnly: false, soundEnabled: false }),
    now,
    now
  );

  createAccountFolders(db, userId, accountId);
  return accountId;
}

export function createLocalAccountForUser(
  db: DatabaseSync,
  userId: string,
  emailAddress: string,
  displayName: string
): string {
  return createHostedAccountForUser(db, userId, emailAddress, displayName, { providerType: 'local' });
}

export function seedStarterCorrespondence(
  db: DatabaseSync,
  userId: string,
  accountId: string,
  userEmail: string,
  userName: string
): { threadsCreated: number } {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

  // Create labels if absent
  const labelSeeds = [
    { name: 'Design Review', color: '#1D4ED8' },
    { name: 'Finance', color: '#059669' },
    { name: 'Action Required', color: '#D97706' },
    { name: 'Security', color: '#DC2626' },
  ];
  for (let i = 0; i < labelSeeds.length; i++) {
    const existing = db
      .prepare('SELECT id FROM labels WHERE user_id = ? AND lower(name) = lower(?)')
      .get(userId, labelSeeds[i].name);
    if (!existing) {
      db.prepare(
        'INSERT INTO labels (id, user_id, account_id, name, color, sort_order, is_favorite, created_at) VALUES (?, ?, NULL, ?, ?, ?, 1, ?)'
      ).run(crypto.randomUUID(), userId, labelSeeds[i].name, labelSeeds[i].color, i + 1, hoursAgo(72));
    }
  }

  // Create contacts
  const contacts = [
    { name: 'Elena Vance', email: 'elena.vance@northstar-labs.io', org: 'Northstar Labs', color: '#1D4ED8' },
    { name: 'Marcus Chen', email: 'm.chen@northstar-labs.io', org: 'Northstar Labs', color: '#0F766E' },
    { name: 'Priya Nair', email: 'priya@atelier-studio.co', org: 'Atelier Studio', color: '#7C3AED' },
    { name: 'Billing Desk', email: 'invoices@cloudgrid.dev', org: 'CloudGrid Infrastructure', color: '#D97706' },
    { name: 'Systems Weekly', email: 'digest@systemsweekly.org', org: 'Systems Weekly', color: '#4F46E5' },
  ];
  for (const c of contacts) {
    db.prepare(
      `INSERT OR IGNORE INTO contacts (id, user_id, name, email, organization, phone, notes, avatar_color, is_favorite, contact_count, last_contacted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', ?, 1, 3, ?, ?, ?)`
    ).run(crypto.randomUUID(), userId, c.name, c.email, c.org, c.color, hoursAgo(5), hoursAgo(48), hoursAgo(5));
  }

  // Sample templates
  const existingTpl = db.prepare('SELECT COUNT(*) AS cnt FROM templates WHERE user_id = ?').get(userId) as { cnt: number };
  if (existingTpl.cnt === 0) {
    db.prepare(
      'INSERT INTO templates (id, user_id, name, subject, body_html, category, shortcut_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      crypto.randomUUID(),
      userId,
      'Quick Follow-up',
      'Following up on our discussion',
      '<p>Hi there,</p><p>Checking in on the items we discussed earlier this week. Let me know if you need anything else from my side to keep this moving.</p>',
      'Work',
      '1',
      hoursAgo(24),
      hoursAgo(24)
    );
    db.prepare(
      'INSERT INTO templates (id, user_id, name, subject, body_html, category, shortcut_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      crypto.randomUUID(),
      userId,
      'Schedule Sync',
      'Scheduling 20 minutes this week',
      '<p>Hello,</p><p>Would Tuesday at 10:30 AM or Thursday at 2:00 PM work for a quick 20-minute review?</p>',
      'Scheduling',
      '2',
      hoursAgo(24),
      hoursAgo(24)
    );
  }

  const msgId1 = `<seed-arch-1-${userId.slice(0, 8)}@northstar-labs.io>`;
  const msgId2 = `<seed-arch-2-${userId.slice(0, 8)}@cadence.local>`;
  const msgId3 = `<seed-arch-3-${userId.slice(0, 8)}@northstar-labs.io>`;

  // Thread 1: Multi-message engineering/design review with attachment
  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-1-${accountId}`,
      remoteThreadId: `thread-arch-${accountId}`,
      messageIdHeader: msgId1,
      inReplyTo: '',
      referencesHeader: '',
      folderRole: 'inbox',
      fromName: 'Elena Vance',
      fromAddress: 'elena.vance@northstar-labs.io',
      to: [{ name: userName, address: userEmail }],
      cc: [{ name: 'Marcus Chen', address: 'm.chen@northstar-labs.io' }],
      bcc: [],
      replyTo: [],
      subject: 'Q4 Synchronization Engine Architecture & Latency Targets',
      rawHtml: `<p>Hi ${userName},</p><p>I attached the updated synchronization sequence benchmark from yesterday's load test. Two key findings before Friday's sign-off:</p><ul><li>Incremental UID delta fetching reduced peak memory by <strong>42%</strong> across 10k-message mailboxes.</li><li>We need your confirmation on the <strong>8-second default undo-send queue</strong> and whether scheduled sends should persist timezone offsets explicitly.</li></ul><p>Can you confirm by <strong>Thursday 4:00 PM</strong> so Marcus can freeze the API schema?</p>`,
      rawText: `Hi ${userName},\n\nI attached the updated synchronization sequence benchmark...`,
      sentAt: hoursAgo(14),
      receivedAt: hoursAgo(14),
      isRead: true,
      isStarred: true,
      isImportant: true,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      labelNames: ['Design Review', 'Action Required'],
      attachments: [
        {
          filename: 'sync-latency-benchmark.csv',
          mimeType: 'text/csv',
          content: Buffer.from('stage,p50_ms,p95_ms,memory_mb\ninitial_sync,184,412,68\nincremental_delta,22,61,19\nfts5_query,4,11,14\n'),
        },
      ],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'work' }
  );

  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-2-${accountId}`,
      remoteThreadId: `thread-arch-${accountId}`,
      messageIdHeader: msgId2,
      inReplyTo: msgId1,
      referencesHeader: msgId1,
      folderRole: 'sent',
      fromName: userName,
      fromAddress: userEmail,
      to: [{ name: 'Elena Vance', address: 'elena.vance@northstar-labs.io' }],
      cc: [{ name: 'Marcus Chen', address: 'm.chen@northstar-labs.io' }],
      bcc: [],
      replyTo: [],
      subject: 'Re: Q4 Synchronization Engine Architecture & Latency Targets',
      rawHtml: `<p>Thanks Elena — those delta numbers look great. Yes, let's lock 8 seconds as the default undo-send window and store IANA timezone names alongside UTC timestamps for scheduled mail.</p>`,
      rawText: `Thanks Elena — those delta numbers look great.`,
      sentAt: hoursAgo(10),
      receivedAt: hoursAgo(10),
      isRead: true,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      attachments: [],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'work' }
  );

  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-3-${accountId}`,
      remoteThreadId: `thread-arch-${accountId}`,
      messageIdHeader: msgId3,
      inReplyTo: msgId2,
      referencesHeader: `${msgId1} ${msgId2}`,
      folderRole: 'inbox',
      fromName: 'Marcus Chen',
      fromAddress: 'm.chen@northstar-labs.io',
      to: [{ name: userName, address: userEmail }],
      cc: [{ name: 'Elena Vance', address: 'elena.vance@northstar-labs.io' }],
      bcc: [],
      replyTo: [],
      subject: 'Re: Q4 Synchronization Engine Architecture & Latency Targets',
      rawHtml: `<p>Confirmed on my end. Schema freeze is scheduled for tomorrow at 11:00 AM. Could you also review the offline pending-queue retry backoff table attached here?</p>`,
      rawText: `Confirmed on my end. Schema freeze is scheduled for tomorrow at 11:00 AM.`,
      sentAt: hoursAgo(1.5),
      receivedAt: hoursAgo(1.5),
      isRead: false,
      isStarred: true,
      isImportant: true,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      labelNames: ['Design Review'],
      attachments: [
        {
          filename: 'retry-backoff-notes.txt',
          mimeType: 'text/plain',
          content: Buffer.from('Retry Schedule:\nAttempt 1: 2s\nAttempt 2: 8s\nAttempt 3: 30s\nAttempt 4: 120s\n'),
        },
      ],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'work' }
  );

  // Thread 2: Atelier Studio design handoff (Primary, unread)
  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-4-${accountId}`,
      messageIdHeader: `<seed-atelier-${userId.slice(0, 8)}@atelier-studio.co>`,
      inReplyTo: '',
      referencesHeader: '',
      folderRole: 'inbox',
      fromName: 'Priya Nair',
      fromAddress: 'priya@atelier-studio.co',
      to: [{ name: userName, address: userEmail }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Final typography tokens & dark surface contrast audit',
      rawHtml: `<p>Hi ${userName},</p><p>We finished the contrast audit across both the Alabaster light palette and Obsidian dark surfaces. All body copy clears <strong>7.2:1</strong> and secondary metadata clears <strong>4.9:1</strong>.</p><p>Decision needed: keep Mineral Cobalt as the default workspace accent, and ship the split-right reading pane as the initial desktop layout.</p>`,
      rawText: `Hi ${userName}, We finished the contrast audit...`,
      sentAt: hoursAgo(3),
      receivedAt: hoursAgo(3),
      isRead: false,
      isStarred: false,
      isImportant: true,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      labelNames: ['Design Review'],
      attachments: [],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'primary' }
  );

  // Thread 3: Invoice update with tracking pixel & security link check demonstration
  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-5-${accountId}`,
      messageIdHeader: `<seed-inv-${userId.slice(0, 8)}@cloudgrid.dev>`,
      inReplyTo: '',
      referencesHeader: '',
      folderRole: 'inbox',
      fromName: 'CloudGrid Billing',
      fromAddress: 'invoices@cloudgrid.dev',
      to: [{ name: userName, address: userEmail }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Invoice #CG-2026-1142 — November Infrastructure Statement',
      rawHtml: `<p>Your November infrastructure statement is ready.</p><p><strong>Total due:</strong> $148.00<br><strong>Due date:</strong> December 5, 2026</p><p><img src="https://metrics.cloudgrid.dev/open-pixel.png" width="1" height="1" alt="" /><img src="https://cdn.cloudgrid.dev/assets/banner-header.png" alt="CloudGrid Statement Header" width="480" /></p><p>Review your itemized statement in the billing console.</p>`,
      rawText: `Your November infrastructure statement is ready. Total due: $148.00. Due date: December 5, 2026.`,
      sentAt: hoursAgo(6),
      receivedAt: hoursAgo(6),
      isRead: false,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      labelNames: ['Finance'],
      attachments: [],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'updates' }
  );

  // Thread 4: Suspicious phishing link demonstration (shows Cadence link safety banner!)
  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-6-${accountId}`,
      messageIdHeader: `<seed-sec-${userId.slice(0, 8)}@security-notice.invalid>`,
      inReplyTo: '',
      referencesHeader: '',
      folderRole: 'inbox',
      fromName: 'Account Verification Notice',
      fromAddress: 'alerts@verify-portal-notice.example',
      to: [{ name: userName, address: userEmail }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Action Notice: Verify external domain certificate',
      rawHtml: `<p>Please inspect the link safety indicator above this message. Cadence automatically flags mismatched anchor URLs such as <a href="http://198.51.100.42/login">https://accounts.trusted-example.com/verify</a> and blocks scripts or tracking beacons.</p>`,
      rawText: `Cadence automatically flags mismatched anchor URLs and IP links.`,
      sentAt: hoursAgo(9),
      receivedAt: hoursAgo(9),
      isRead: true,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      labelNames: ['Security'],
      authResults: { spf: 'softfail', dkim: 'none', dmarc: 'fail' },
      attachments: [],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'updates' }
  );

  // Thread 5: Newsletter
  ingestMessage(
    db,
    userId,
    accountId,
    {
      remoteId: `seed-7-${accountId}`,
      messageIdHeader: `<seed-news-${userId.slice(0, 8)}@systemsweekly.org>`,
      inReplyTo: '',
      referencesHeader: '',
      folderRole: 'inbox',
      fromName: 'Systems Weekly',
      fromAddress: 'digest@systemsweekly.org',
      to: [{ name: userName, address: userEmail }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Issue #218: Local-first SQLite engines, FTS5 ranking, and zero-flicker virtualization',
      rawHtml: `<p><strong>In this week's edition:</strong></p><ul><li>How WAL mode and FTS5 prefix indexing eliminate client-side search lag.</li><li>Designing resilient outbox queues for offline-capable desktop and web software.</li></ul><p><small>To manage preferences, reply with unsubscribe.</small></p>`,
      rawText: `Issue #218: Local-first SQLite engines, FTS5 ranking, and zero-flicker virtualization.`,
      sentAt: hoursAgo(18),
      receivedAt: hoursAgo(18),
      isRead: true,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      attachments: [],
    },
    { skipNotifications: true, skipRules: true, explicitCategory: 'newsletters' }
  );

  return { threadsCreated: 5 };
}
