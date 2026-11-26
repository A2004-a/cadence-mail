import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config, isSeaApp, saveRuntimeEnvSettings } from '../config.js';
import { getDb } from '../db/database.js';
import { buildGmailAuthUrl, exchangeGmailCode, isGmailOAuthConfigured } from '../providers/gmailAdapter.js';
import { buildOutlookAuthUrl, exchangeOutlookCode, isOutlookOAuthConfigured } from '../providers/outlookAdapter.js';
import { getProviderAdapter, getProviderCapabilities, getProviderSetupStatus } from '../providers/registry.js';
import type { ImapSmtpCredentials, ProviderCredentials } from '../providers/types.js';
import { param, requireAuth } from '../security/authMiddleware.js';
import { createPkcePair, decryptSecret, encryptSecret, generateToken } from '../security/crypto.js';
import { sanitizeComposerHtml } from '../security/sanitize.js';
import { createAccountFolders, createHostedAccountForUser, createLocalAccountForUser, seedStarterCorrespondence } from '../services/accountSetup.js';
import { getAiProviderStatus } from '../services/aiService.js';
import { listPublicActiveDomains } from '../services/domainService.js';
import { recordSecurityEvent } from '../services/securityLogService.js';
import { clearSyncBackoff, syncAccount } from '../services/syncService.js';

export const accountsRouter = Router();

accountsRouter.get('/providers/status', requireAuth, (req, res) => {
  res.json({
    providers: getProviderSetupStatus(),
    ai: {
      ...getAiProviderStatus(),
      providersConfigured: {
        gemini: Boolean(config.ai.geminiApiKey),
        openai: Boolean(config.ai.openaiApiKey),
        anthropic: Boolean(config.ai.anthropicApiKey),
      },
      models: {
        gemini: config.ai.geminiModel,
        openai: config.ai.openaiModel,
        openaiBaseUrl: config.ai.openaiBaseUrl,
        anthropic: config.ai.anthropicModel,
      },
    },
    oauthConfig: {
      microsoftTenantId: config.oauth.microsoft.tenantId,
      isDesktopLoopback: isSeaApp || config.oauth.google.redirectUri.includes('127.0.0.1'),
    },
    oauthRedirectUris: {
      gmail: config.oauth.google.redirectUri,
      outlook: config.oauth.microsoft.redirectUri,
    },
    canConfigureServerProviders: req.auth!.role === 'admin',
  });
});

accountsRouter.post('/providers/configure', requireAuth, (req, res) => {
  if (req.auth!.role !== 'admin') {
    recordSecurityEvent({
      userId: req.auth!.id,
      eventType: 'provider_config_denied',
      severity: 'warning',
      actorEmail: req.auth!.email,
      ipAddress: req.ip,
      details: { reason: 'Non-admin attempted server provider configuration' },
    });
    res.status(403).json({ error: 'Administrator privileges required to update server-wide OAuth or AI credentials.' });
    return;
  }

  const schema = z.object({
    googleClientId: z.string().max(300).optional(),
    googleClientSecret: z.string().max(300).optional(),
    microsoftClientId: z.string().max(300).optional(),
    microsoftClientSecret: z.string().max(300).optional(),
    microsoftTenantId: z.string().max(120).optional(),
    geminiApiKey: z.string().max(300).optional(),
    geminiModel: z.string().max(120).optional(),
    openaiApiKey: z.string().max(300).optional(),
    openaiModel: z.string().max(120).optional(),
    openaiBaseUrl: z.string().max(300).optional(),
    anthropicApiKey: z.string().max(300).optional(),
    anthropicModel: z.string().max(120).optional(),
    clearKeys: z.array(z.enum(['google', 'microsoft', 'gemini', 'openai', 'anthropic'])).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid provider configuration values' });
    return;
  }
  const d = parsed.data;
  if (d.openaiBaseUrl && d.openaiBaseUrl.trim() && !/^https?:\/\/\S+$/i.test(d.openaiBaseUrl.trim())) {
    res.status(400).json({ error: 'OpenAI base URL must start with http:// or https://' });
    return;
  }

  const updates: Record<string, string> = {};
  if (d.googleClientId !== undefined) updates.GOOGLE_CLIENT_ID = d.googleClientId;
  if (d.googleClientSecret !== undefined) updates.GOOGLE_CLIENT_SECRET = d.googleClientSecret;
  if (d.microsoftClientId !== undefined) updates.MICROSOFT_CLIENT_ID = d.microsoftClientId;
  if (d.microsoftClientSecret !== undefined) updates.MICROSOFT_CLIENT_SECRET = d.microsoftClientSecret;
  if (d.microsoftTenantId !== undefined) updates.MICROSOFT_TENANT_ID = d.microsoftTenantId;
  if (d.geminiApiKey !== undefined) updates.GEMINI_API_KEY = d.geminiApiKey;
  if (d.geminiModel !== undefined) updates.GEMINI_MODEL = d.geminiModel;
  if (d.openaiApiKey !== undefined) updates.OPENAI_API_KEY = d.openaiApiKey;
  if (d.openaiModel !== undefined) updates.OPENAI_MODEL = d.openaiModel;
  if (d.openaiBaseUrl !== undefined) updates.OPENAI_BASE_URL = d.openaiBaseUrl;
  if (d.anthropicApiKey !== undefined) updates.ANTHROPIC_API_KEY = d.anthropicApiKey;
  if (d.anthropicModel !== undefined) updates.ANTHROPIC_MODEL = d.anthropicModel;

  for (const keyGroup of d.clearKeys || []) {
    if (keyGroup === 'google') {
      updates.GOOGLE_CLIENT_ID = '';
      updates.GOOGLE_CLIENT_SECRET = '';
    } else if (keyGroup === 'microsoft') {
      updates.MICROSOFT_CLIENT_ID = '';
      updates.MICROSOFT_CLIENT_SECRET = '';
      updates.MICROSOFT_TENANT_ID = '';
    } else if (keyGroup === 'gemini') {
      updates.GEMINI_API_KEY = '';
    } else if (keyGroup === 'openai') {
      updates.OPENAI_API_KEY = '';
    } else if (keyGroup === 'anthropic') {
      updates.ANTHROPIC_API_KEY = '';
    }
  }

  saveRuntimeEnvSettings(updates);
  recordSecurityEvent({
    userId: req.auth!.id,
    eventType: 'provider_credentials_configured',
    severity: 'info',
    actorEmail: req.auth!.email,
    ipAddress: req.ip,
    details: { updatedFields: Object.keys(updates) },
  });

  res.json({
    ok: true,
    providers: getProviderSetupStatus(),
    ai: {
      ...getAiProviderStatus(),
      providersConfigured: {
        gemini: Boolean(config.ai.geminiApiKey),
        openai: Boolean(config.ai.openaiApiKey),
        anthropic: Boolean(config.ai.anthropicApiKey),
      },
      models: {
        gemini: config.ai.geminiModel,
        openai: config.ai.openaiModel,
        openaiBaseUrl: config.ai.openaiBaseUrl,
        anthropic: config.ai.anthropicModel,
      },
    },
    oauthConfig: {
      microsoftTenantId: config.oauth.microsoft.tenantId,
      isDesktopLoopback: isSeaApp || config.oauth.google.redirectUri.includes('127.0.0.1'),
    },
  });
});

accountsRouter.get('/domains/available', requireAuth, (_req, res) => {
  res.json({ domains: listPublicActiveDomains() });
});

accountsRouter.post('/hosted', requireAuth, (req, res) => {
  const schema = z.object({
    domainId: z.string().min(1),
    localPart: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/),
    displayName: z.string().trim().min(1).max(100),
    setDefault: z.boolean().optional().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a valid local-part (letters, digits, ., _, +, -) and display name.' });
    return;
  }

  const db = getDb();
  const domain = db
    .prepare("SELECT id, domain, status FROM domains WHERE id = ? AND status = 'active'")
    .get(parsed.data.domainId) as { id: string; domain: string; status: string } | undefined;
  if (!domain) {
    res.status(404).json({ error: 'Active hosted email domain not found. Configure and activate a domain in Administration -> Domains first.' });
    return;
  }

  const fullAddress = `${parsed.data.localPart.toLowerCase()}@${domain.domain.toLowerCase()}`;
  const conflictAcct = db
    .prepare("SELECT id FROM accounts WHERE provider_type IN ('hosted', 'local') AND lower(email_address) = lower(?)")
    .get(fullAddress);
  const conflictAlias = db
    .prepare('SELECT id FROM mailbox_aliases WHERE lower(alias_address) = lower(?)')
    .get(fullAddress);
  const userDup = db
    .prepare('SELECT id FROM accounts WHERE user_id = ? AND lower(email_address) = lower(?)')
    .get(req.auth!.id, fullAddress);

  if (conflictAcct || conflictAlias || userDup) {
    res.status(409).json({ error: `The hosted email address ${fullAddress} is already assigned.` });
    return;
  }

  const accountId = createHostedAccountForUser(db, req.auth!.id, fullAddress, parsed.data.displayName, {
    domainId: domain.id,
    isDefault: parsed.data.setDefault,
    providerType: 'hosted',
  });

  recordSecurityEvent(
    {
      userId: req.auth!.id,
      eventType: 'hosted_mailbox_created',
      severity: 'info',
      actorEmail: fullAddress,
      details: { domain: domain.domain },
    },
    db
  );

  res.status(201).json({ accountId, emailAddress: fullAddress });
});

accountsRouter.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.provider_type, a.account_ownership, a.domain_id, a.email_address, a.display_name, a.avatar_color,
              a.signature_html, a.signature_enabled, a.status, a.is_default, a.quota_mb, a.used_bytes, a.capabilities_json,
              a.last_synced_at, a.last_error, a.notification_prefs_json, a.created_at,
              (SELECT COUNT(*) FROM threads t WHERE t.account_id = a.id AND t.in_inbox = 1 AND t.unread_count > 0) AS unread_count
       FROM accounts a
       WHERE a.user_id = ?
       ORDER BY a.is_default DESC, a.created_at ASC`
    )
    .all(req.auth!.id) as Array<Record<string, any>>;

  res.json({
    accounts: rows.map((a) => ({
      id: a.id,
      providerType: a.provider_type,
      accountOwnership: a.account_ownership || (a.provider_type === 'hosted' || a.provider_type === 'local' ? 'hosted' : 'external'),
      domainId: a.domain_id || null,
      emailAddress: a.email_address,
      displayName: a.display_name,
      avatarColor: a.avatar_color,
      signatureHtml: a.signature_html,
      signatureEnabled: Boolean(a.signature_enabled),
      status: a.status,
      isDefault: Boolean(a.is_default),
      quotaMb: a.quota_mb || 1024,
      usedBytes: a.used_bytes || 0,
      capabilities: JSON.parse(a.capabilities_json),
      lastSyncedAt: a.last_synced_at,
      lastError: a.last_error,
      notificationPrefs: JSON.parse(a.notification_prefs_json || '{}'),
      unreadCount: a.unread_count,
      createdAt: a.created_at,
    })),
  });
});

const localAccountSchema = z.object({
  emailAddress: z.string().trim().email(),
  displayName: z.string().trim().min(1).max(100),
  seedStarter: z.boolean().optional().default(false),
});

accountsRouter.post('/local', requireAuth, (req, res) => {
  const parsed = localAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email address and display name required' });
    return;
  }

  const db = getDb();
  const exists = db
    .prepare('SELECT id FROM accounts WHERE user_id = ? AND lower(email_address) = lower(?)')
    .get(req.auth!.id, parsed.data.emailAddress);
  if (exists) {
    res.status(409).json({ error: 'This email address is already connected to your workspace' });
    return;
  }

  const accountId = createLocalAccountForUser(
    db,
    req.auth!.id,
    parsed.data.emailAddress.toLowerCase(),
    parsed.data.displayName
  );
  if (parsed.data.seedStarter) {
    seedStarterCorrespondence(
      db,
      req.auth!.id,
      accountId,
      parsed.data.emailAddress.toLowerCase(),
      parsed.data.displayName
    );
  }
  res.status(201).json({ accountId });
});

const imapAccountSchema = z.object({
  providerType: z.enum(['imap_smtp', 'yahoo']).optional().default('imap_smtp'),
  emailAddress: z.string().trim().email(),
  displayName: z.string().trim().min(1).max(100),
  imapHost: z.string().trim().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().trim().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

accountsRouter.post('/test-imap', requireAuth, async (req, res) => {
  const parsed = imapAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid IMAP/SMTP configuration' });
    return;
  }
  const { providerType, ...rest } = parsed.data;
  const creds: ImapSmtpCredentials = { type: providerType, ...rest };
  const adapter = getProviderAdapter(providerType);
  const result = await adapter.testConnection(creds);
  res.status(result.ok ? 200 : 400).json(result);
});

accountsRouter.post('/imap', requireAuth, async (req, res) => {
  const parsed = imapAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid IMAP/SMTP configuration', details: parsed.error.flatten() });
    return;
  }

  const { providerType, ...rest } = parsed.data;
  const creds: ImapSmtpCredentials = { type: providerType, ...rest };
  const adapter = getProviderAdapter(providerType);
  const testRes = await adapter.testConnection(creds);
  if (!testRes.ok) {
    res.status(400).json({ error: testRes.error || 'Unable to authenticate with IMAP/SMTP server' });
    return;
  }

  const db = getDb();
  const normalizedEmail = parsed.data.emailAddress.toLowerCase();
  const existing = db
    .prepare('SELECT id FROM accounts WHERE user_id = ? AND lower(email_address) = lower(?)')
    .get(req.auth!.id, normalizedEmail) as { id: string } | undefined;

  const now = new Date().toISOString();
  const encrypted = encryptSecret(JSON.stringify(creds));
  const accountId = existing?.id || crypto.randomUUID();

  if (existing) {
    clearSyncBackoff(accountId);
    db.prepare(
      `UPDATE accounts
       SET provider_type = ?, account_ownership = 'external', display_name = ?, capabilities_json = ?, encrypted_credentials = ?,
           status = 'connected', last_error = NULL, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      providerType,
      parsed.data.displayName,
      JSON.stringify(getProviderCapabilities(providerType)),
      encrypted,
      now,
      accountId,
      req.auth!.id
    );
  } else {
    db.prepare(
      `INSERT INTO accounts (id, user_id, provider_type, account_ownership, email_address, display_name, avatar_color, signature_html, signature_enabled, status, capabilities_json, encrypted_credentials, sync_cursor, last_synced_at, notification_prefs_json, created_at, updated_at)
       VALUES (?, ?, ?, 'external', ?, ?, '#0F766E', ?, 1, 'connected', ?, ?, '', NULL, ?, ?, ?)`
    ).run(
      accountId,
      req.auth!.id,
      providerType,
      normalizedEmail,
      parsed.data.displayName,
      `<p>Best regards,<br><strong>${parsed.data.displayName}</strong></p>`,
      JSON.stringify(getProviderCapabilities(providerType)),
      encrypted,
      JSON.stringify({ enabled: true, importantOnly: false, soundEnabled: false }),
      now,
      now
    );
    createAccountFolders(db, req.auth!.id, accountId);
  }

  const syncRes = await syncAccount(accountId, req.auth!.id, db);
  res.status(existing ? 200 : 201).json({ accountId, sync: syncRes });
});

function resolveSafeRedirectOrigin(req: { headers: Record<string, unknown> }): string {
  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const rawReferer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
  let candidate = rawOrigin;
  if (!candidate && rawReferer) {
    try {
      candidate = new URL(rawReferer).origin;
    } catch {
      candidate = '';
    }
  }
  if (
    candidate &&
    (candidate === config.clientOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(candidate))
  ) {
    return candidate.replace(/\/$/, '');
  }
  return config.clientOrigin.replace(/\/$/, '');
}

accountsRouter.get('/oauth/:provider/start', requireAuth, (req, res) => {
  const provider = req.params.provider;
  if (provider !== 'gmail' && provider !== 'outlook') {
    res.status(400).json({ error: 'Unsupported OAuth provider' });
    return;
  }

  if (provider === 'gmail' && !isGmailOAuthConfigured()) {
    res.status(400).json({
      error: 'Gmail OAuth is not configured on this server',
      missingEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      setupUrl: '/README.md',
    });
    return;
  }

  if (provider === 'outlook' && !isOutlookOAuthConfigured()) {
    res.status(400).json({
      error: 'Microsoft 365 / Outlook OAuth is not configured on this server',
      missingEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
      setupUrl: '/README.md',
    });
    return;
  }

  const includeCalendar = req.query.includeCalendar === 'true' || req.query.includeCalendar === '1';
  const db = getDb();
  const state = generateToken(24);
  const pkce = createPkcePair();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const redirectAfter = resolveSafeRedirectOrigin(req);

  db.prepare(
    'INSERT INTO oauth_states (state, user_id, provider_type, code_verifier, redirect_after, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(state, req.auth!.id, provider, pkce.verifier, redirectAfter, expiresAt, now.toISOString());

  const url =
    provider === 'gmail'
      ? buildGmailAuthUrl(state, pkce.challenge, includeCalendar)
      : buildOutlookAuthUrl(state, pkce.challenge, includeCalendar);

  res.json({ authUrl: url });
});

accountsRouter.get('/oauth/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const error = String(req.query.error || '');
  const errorDesc = String(req.query.error_description || '');

  const db = getDb();
  const stateRow = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider_type = ?').get(state, provider) as
    | {
        state: string;
        user_id: string;
        provider_type: 'gmail' | 'outlook';
        code_verifier: string;
        redirect_after: string;
        expires_at: string;
      }
    | undefined;

  const targetOrigin = (stateRow?.redirect_after || config.clientOrigin).replace(/\/$/, '');

  if (error) {
    if (stateRow) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    res.redirect(`${targetOrigin}/?oauth_error=${encodeURIComponent(errorDesc || error)}`);
    return;
  }

  if (!stateRow || new Date(stateRow.expires_at).getTime() <= Date.now()) {
    res.redirect(`${targetOrigin}/?oauth_error=expired_state`);
    return;
  }
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  try {
    const creds =
      provider === 'gmail'
        ? await exchangeGmailCode(code, stateRow.code_verifier)
        : await exchangeOutlookCode(code, stateRow.code_verifier);

    const existing = db
      .prepare('SELECT id FROM accounts WHERE user_id = ? AND lower(email_address) = lower(?)')
      .get(stateRow.user_id, creds.email) as { id: string } | undefined;

    const now = new Date().toISOString();
    const encrypted = encryptSecret(JSON.stringify(creds));
    let accountId = existing?.id;

    if (accountId) {
      clearSyncBackoff(accountId);
      db.prepare("UPDATE accounts SET encrypted_credentials = ?, status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?").run(
        encrypted,
        now,
        accountId
      );
    } else {
      accountId = crypto.randomUUID();
      const existingCount = (
        db.prepare('SELECT COUNT(*) AS c FROM accounts WHERE user_id = ?').get(stateRow.user_id) as { c: number }
      ).c;
      const fallbackName = creds.email.split('@')[0];
      db.prepare(
        `INSERT INTO accounts (id, user_id, provider_type, account_ownership, email_address, display_name, avatar_color, signature_html, signature_enabled, status, is_default, capabilities_json, encrypted_credentials, sync_cursor, notification_prefs_json, created_at, updated_at)
         VALUES (?, ?, ?, 'external', ?, ?, ?, ?, 1, 'connected', ?, ?, ?, '', ?, ?, ?)`
      ).run(
        accountId,
        stateRow.user_id,
        provider,
        creds.email,
        fallbackName,
        provider === 'gmail' ? '#DC2626' : '#0284C7',
        `<p>Best regards,<br><strong>${fallbackName}</strong></p>`,
        existingCount === 0 ? 1 : 0,
        JSON.stringify(getProviderCapabilities(provider as 'gmail' | 'outlook')),
        encrypted,
        JSON.stringify({ enabled: true, importantOnly: false, soundEnabled: false }),
        now,
        now
      );
      createAccountFolders(db, stateRow.user_id, accountId);
    }

    await syncAccount(accountId, stateRow.user_id, db);
    res.redirect(`${targetOrigin}/?oauth_connected=${encodeURIComponent(creds.email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OAuth failure';
    res.redirect(`${targetOrigin}/?oauth_error=${encodeURIComponent(msg)}`);
  }
});

accountsRouter.post('/:id/sync', requireAuth, async (req, res) => {
  const result = await syncAccount(String(req.params.id), req.auth!.id);
  res.status(result.ok ? 200 : 400).json(result);
});

const patchAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  signatureHtml: z.string().max(10_000).optional(),
  signatureEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(['connected', 'disconnected']).optional(),
  notificationPrefs: z.record(z.unknown()).optional(),
});

accountsRouter.patch('/:id', requireAuth, (req, res) => {
  const id = param(req, 'id');
  const parsed = patchAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid account settings' });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(id, req.auth!.id);
  if (!existing) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  const d = parsed.data;
  const now = new Date().toISOString();
  if (d.displayName !== undefined) {
    db.prepare('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?').run(d.displayName, now, id);
  }
  if (d.avatarColor !== undefined) {
    db.prepare('UPDATE accounts SET avatar_color = ?, updated_at = ? WHERE id = ?').run(d.avatarColor, now, id);
  }
  if (d.signatureHtml !== undefined) {
    db.prepare('UPDATE accounts SET signature_html = ?, updated_at = ? WHERE id = ?').run(
      sanitizeComposerHtml(d.signatureHtml),
      now,
      id
    );
  }
  if (d.signatureEnabled !== undefined) {
    db.prepare('UPDATE accounts SET signature_enabled = ?, updated_at = ? WHERE id = ?').run(
      d.signatureEnabled ? 1 : 0,
      now,
      id
    );
  }
  if (d.isDefault === true) {
    db.prepare('UPDATE accounts SET is_default = 0, updated_at = ? WHERE user_id = ?').run(now, req.auth!.id);
    db.prepare('UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?').run(now, id);
  }
  if (d.status !== undefined) {
    db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(d.status, now, id);
  }
  if (d.notificationPrefs !== undefined) {
    db.prepare('UPDATE accounts SET notification_prefs_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(d.notificationPrefs),
      now,
      id
    );
  }

  res.json({ ok: true });
});

const updateCredentialsSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  imapHost: z.string().trim().min(1).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  smtpHost: z.string().trim().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
});

accountsRouter.patch('/:id/credentials', requireAuth, async (req, res) => {
  const id = param(req, 'id');
  const parsed = updateCredentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid credential update payload' });
    return;
  }

  const db = getDb();
  const row = db
    .prepare('SELECT id, provider_type, email_address, display_name, encrypted_credentials FROM accounts WHERE id = ? AND user_id = ?')
    .get(id, req.auth!.id) as
    | { id: string; provider_type: string; email_address: string; display_name: string; encrypted_credentials: string }
    | undefined;

  if (!row) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  if (row.provider_type !== 'imap_smtp' && row.provider_type !== 'yahoo') {
    res.status(400).json({ error: 'Use OAuth re-authorization for Gmail/Outlook or Admin tools for hosted accounts.' });
    return;
  }

  let currentCreds: ImapSmtpCredentials;
  try {
    currentCreds = JSON.parse(decryptSecret(row.encrypted_credentials)) as ImapSmtpCredentials;
  } catch {
    res.status(400).json({ error: 'Existing stored credentials cannot be decoded; supply full IMAP/SMTP parameters.' });
    return;
  }

  const d = parsed.data;
  const nextCreds: ImapSmtpCredentials = {
    type: row.provider_type === 'yahoo' ? 'yahoo' : 'imap_smtp',
    imapHost: d.imapHost ?? currentCreds.imapHost,
    imapPort: d.imapPort ?? currentCreds.imapPort,
    imapSecure: d.imapSecure ?? currentCreds.imapSecure,
    smtpHost: d.smtpHost ?? currentCreds.smtpHost,
    smtpPort: d.smtpPort ?? currentCreds.smtpPort,
    smtpSecure: d.smtpSecure ?? currentCreds.smtpSecure,
    username: d.username ?? currentCreds.username,
    password: d.password ?? currentCreds.password,
  };

  const adapter = getProviderAdapter(row.provider_type as 'imap_smtp' | 'yahoo');
  const testRes = await adapter.testConnection(nextCreds);
  if (!testRes.ok) {
    res.status(400).json({ error: testRes.error || 'Updated IMAP/SMTP credentials failed verification' });
    return;
  }

  const now = new Date().toISOString();
  clearSyncBackoff(id);
  db.prepare(
    `UPDATE accounts
     SET display_name = ?, encrypted_credentials = ?, status = 'connected', last_error = NULL, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(d.displayName ?? row.display_name, encryptSecret(JSON.stringify(nextCreds)), now, id, req.auth!.id);

  recordSecurityEvent({
    userId: req.auth!.id,
    eventType: 'account_credentials_updated',
    severity: 'info',
    actorEmail: row.email_address,
    ipAddress: req.ip,
    details: { accountId: id, providerType: row.provider_type },
  });

  const syncRes = await syncAccount(id, req.auth!.id, db);
  res.json({ ok: true, sync: syncRes });
});

accountsRouter.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const resDel = db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(param(req, 'id'), req.auth!.id);
  if (resDel.changes === 0) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  res.json({ ok: true });
});

accountsRouter.get('/:id/sync-logs', requireAuth, (req, res) => {
  const db = getDb();
  const logs = db
    .prepare('SELECT id, status, messages_added, messages_updated, duration_ms, error_message, created_at FROM sync_logs WHERE account_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(param(req, 'id'), req.auth!.id);
  res.json({ logs });
});
