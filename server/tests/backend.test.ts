import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-test-'));
process.env.CADENCE_DATA_DIR = tempDir;
process.env.CADENCE_DB_PATH = path.join(tempDir, 'test.db');
process.env.CADENCE_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { createApp } = await import('../src/app.js');
const { closeDb, getDb } = await import('../src/db/database.js');
const { decryptSecret, encryptSecret } = await import('../src/security/crypto.js');
const { sanitizeEmailContent } = await import('../src/security/sanitize.js');
const { redactSensitivePatterns } = await import('../src/services/aiService.js');
const { processMailQueue, waitForMailQueueIdle } = await import('../src/services/mailDeliveryEngine.js');
const { processDueBackgroundJobs } = await import('../src/services/sendService.js');

/** Allocates an ephemeral loopback TCP port and immediately closes it for deterministic refusal testing. */
async function allocateClosedPort(): Promise<number> {
  const netMod = await import('node:net');
  const srv = netMod.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  const port = addr && typeof addr === 'object' ? addr.port : 1;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl = '';

async function api(
  urlPath: string,
  opts: { method?: string; body?: any; cookie?: string; csrf?: string } = {}
): Promise<{ status: number; headers: Headers; data: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

before(async () => {
  getDb();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(async () => {
  await waitForMailQueueIdle();
  (server as any).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore Windows file lock
  }
});

describe('Security & Sanitization', () => {
  it('encrypts and decrypts credentials with AES-256-GCM', () => {
    const secret = JSON.stringify({ password: 'app-password-xyz', refreshToken: 'rt_123' });
    const enc = encryptSecret(secret);
    assert.notEqual(enc, secret);
    assert.equal(decryptSecret(enc), secret);
  });

  it('sanitizes XSS scripts, blocks tracking pixels, flags mismatched links, and masks remote images', () => {
    const dirty = `
      <div>Hello <script>alert("xss")</script><img src="x" onerror="steal()" /></div>
      <img src="https://track.example.com/pixel.png" width="1" height="1" />
      <img src="https://cdn.example.com/hero.png" width="300" />
      <a href="javascript:alert(1)">Click</a>
      <a href="http://203.0.113.5/login">https://bank.example.com/login</a>
    `;
    const result = sanitizeEmailContent(dirty);
    assert.equal(result.html.includes('<script'), false);
    assert.equal(result.html.includes('onerror'), false);
    assert.equal(result.html.includes('javascript:'), false);
    assert.equal(result.html.includes('pixel.png'), false);
    assert.equal(result.hasExternalImages, true);
    assert.equal(result.html.includes('data-blocked-src="https://cdn.example.com/hero.png"'), true);
    assert.ok(result.suspiciousLinks.length >= 2);
  });

  it('redacts sensitive tokens before AI processing', () => {
    const text = 'Card 4111 2222 3333 4444 and key sk-abcdef1234567890abcdef and password: MySecret99';
    const redacted = redactSensitivePatterns(text);
    assert.equal(redacted.includes('4111'), false);
    assert.equal(redacted.includes('sk-abcdef'), false);
    assert.equal(redacted.includes('MySecret99'), false);
  });
});

describe('Auth, Multi-Account Delivery, Drafts, Search, Rules & Productivity', () => {
  let cookieA = '';
  let csrfA = '';
  let accountA = '';
  let cookieB = '';
  let csrfB = '';
  let accountB = '';

  it('registers two users, enforces CSRF protection, and seeds correspondence', async () => {
    const regA = await api('/api/v1/auth/register', {
      method: 'POST',
      body: {
        name: 'Alice Mercer',
        email: 'alice@cadence.local',
        password: 'StrongPassword123!',
        provisionLocalMailbox: true,
        seedStarter: true,
      },
    });
    assert.equal(regA.status, 201);
    cookieA = regA.headers.get('set-cookie')?.split(';')[0] || '';
    csrfA = regA.data.csrfToken;
    accountA = regA.data.createdAccountId;
    assert.ok(cookieA && csrfA && accountA);

    // CSRF rejection test
    const badCsrf = await api('/api/v1/org/labels', {
      method: 'POST',
      cookie: cookieA,
      body: { name: 'Forbidden', color: '#2563EB' },
    });
    assert.equal(badCsrf.status, 403);

    const regB = await api('/api/v1/auth/register', {
      method: 'POST',
      body: {
        name: 'Bob Lindqvist',
        email: 'bob@cadence.local',
        password: 'StrongPassword456!',
        provisionLocalMailbox: true,
        seedStarter: false,
      },
    });
    assert.equal(regB.status, 201);
    cookieB = regB.headers.get('set-cookie')?.split(';')[0] || '';
    csrfB = regB.data.csrfToken;
    accountB = regB.data.createdAccountId;
  });

  it('creates rules with live preview, delivers mail with attachment, and triggers rule', async () => {
    // Bob creates a rule that labels & stars mail from Alice
    const labelRes = await api('/api/v1/org/labels', {
      method: 'POST',
      cookie: cookieB,
      csrf: csrfB,
      body: { name: 'VIP Partner', color: '#059669', isFavorite: true },
    });
    assert.equal(labelRes.status, 201);
    const labelId = labelRes.data.label.id;

    const ruleRes = await api('/api/v1/org/rules', {
      method: 'POST',
      cookie: cookieB,
      csrf: csrfB,
      body: {
        name: 'Tag Alice VIP',
        matchMode: 'all',
        conditions: [{ field: 'from', operator: 'contains', value: 'alice@cadence.local' }],
        actions: [
          { type: 'apply_label', value: labelId },
          { type: 'star' },
          { type: 'notify' },
        ],
      },
    });
    assert.equal(ruleRes.status, 201);

    // Alice drafts an email with attachment & version conflict protection
    const draftRes = await api('/api/v1/drafts', {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: {
        accountId: accountA,
        to: [{ name: 'Bob Lindqvist', address: 'bob@cadence.local' }],
        subject: 'Quarterly Contract Addendum',
        bodyHtml: '<p>Please review the attached addendum for Q4.</p>',
      },
    });
    assert.equal(draftRes.status, 201);
    const draftId = draftRes.data.draft.id;

    const attRes = await api(`/api/v1/drafts/${draftId}/attachments`, {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: {
        filename: 'addendum.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Section 1: Terms agreed.').toString('base64'),
      },
    });
    assert.equal(attRes.status, 201);

    // Send with undo delay -> cancel undo -> send immediately
    const queueRes = await api(`/api/v1/drafts/${draftId}/send`, {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: { undoDelaySeconds: 10 },
    });
    assert.equal(queueRes.status, 200);
    assert.equal(queueRes.data.status, 'queued_undo');

    const cancelRes = await api(`/api/v1/drafts/${draftId}/cancel-undo`, {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
    });
    assert.equal(cancelRes.status, 200);

    const sendNow = await api(`/api/v1/drafts/${draftId}/send`, {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: { undoDelaySeconds: 0 },
    });
    assert.equal(sendNow.status, 200);
    assert.equal(sendNow.data.status, 'sent');

    // Verify Bob received it with rule applied (starred + VIP label + attachment)
    const bobInbox = await api('/api/v1/threads?view=inbox', { cookie: cookieB });
    assert.equal(bobInbox.status, 200);
    assert.equal(bobInbox.data.threads.length, 1);
    const thread = bobInbox.data.threads[0];
    assert.equal(thread.subject, 'Quarterly Contract Addendum');
    assert.equal(thread.isStarred, true);
    assert.equal(thread.hasAttachments, true);
    assert.ok(thread.labels.some((l: any) => l.name === 'VIP Partner'));

    // Verify FTS5 operator search works for Bob
    const searchRes = await api('/api/v1/org/search?q=' + encodeURIComponent('from:alice has:attachment addendum'), {
      cookie: cookieB,
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.data.threads.length, 1);
  });

  it('persists and dispatches scheduled messages, wakes snoozed threads, and triggers due reminders', async () => {
    const db = getDb();
    const schedDraft = await api('/api/v1/drafts', {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: {
        accountId: accountA,
        to: [{ name: 'Bob', address: 'bob@cadence.local' }],
        subject: 'Scheduled Followup Dispatch',
        bodyHtml: '<p>Delivered by scheduler worker.</p>',
      },
    });
    const draftId = schedDraft.data.draft.id;
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const schedRes = await api(`/api/v1/drafts/${draftId}/schedule`, {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: { scheduledFor: futureIso, timezone: 'America/New_York' },
    });
    assert.equal(schedRes.status, 200);
    assert.equal(schedRes.data.status, 'scheduled');

    // Fast-forward scheduled_for to past in DB and invoke worker
    db.prepare('UPDATE drafts SET scheduled_for = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), draftId);
    await processDueBackgroundJobs(db);

    const bobSearch = await api('/api/v1/org/search?q=' + encodeURIComponent('"Scheduled Followup Dispatch"'), {
      cookie: cookieB,
    });
    assert.equal(bobSearch.data.threads.length, 1);

    // Snooze & wake test
    const bobThreadId = bobSearch.data.threads[0].id;
    await api('/api/v1/threads/bulk', {
      method: 'POST',
      cookie: cookieB,
      csrf: csrfB,
      body: { threadIds: [bobThreadId], action: 'snooze', snoozedUntil: new Date(Date.now() + 60_000).toISOString() },
    });
    const snoozedList = await api('/api/v1/threads?view=snoozed', { cookie: cookieB });
    assert.equal(snoozedList.data.threads.length, 1);

    db.prepare('UPDATE threads SET snoozed_until = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      bobThreadId
    );
    await processDueBackgroundJobs(db);
    const inboxAfterWake = await api('/api/v1/threads?view=inbox', { cookie: cookieB });
    assert.ok(inboxAfterWake.data.threads.some((t: any) => t.id === bobThreadId));
  });

  it('reports honest AI unconfigured / consent status and persists preferences', async () => {
    const aiStatus = await api('/api/v1/productivity/ai/status', { cookie: cookieA });
    assert.equal(aiStatus.status, 200);
    assert.equal(aiStatus.data.enabledByUser, false);

    const prefsRes = await api('/api/v1/productivity/preferences', {
      method: 'PATCH',
      cookie: cookieA,
      csrf: csrfA,
      body: {
        appearance: { theme: 'dark', accentColor: '#059669' },
        ai: { enabled: true, privacyDisclosureAccepted: true },
      },
    });
    assert.equal(prefsRes.status, 200);
    assert.equal(prefsRes.data.preferences.appearance.theme, 'dark');

    const aiTransform = await api('/api/v1/productivity/ai/transform', {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: { action: 'rewrite', content: 'Hello team' },
    });
    // Without API key set in test env, returns honest 503 AI_UNCONFIGURED
    assert.equal(aiTransform.status, 503);
    assert.equal(aiTransform.data.code, 'AI_UNCONFIGURED');
  });

  it('enforces attachment CSP sandbox headers, supports rule reorder/edit, and respects quiet hours', async () => {
    // 1. Verify attachment CSP sandbox header & nosniff on stored attachment
    const bobSearch = await api('/api/v1/org/search?q=' + encodeURIComponent('addendum'), { cookie: cookieB });
    const tid = bobSearch.data.threads[0].id;
    const detail = await api(`/api/v1/threads/${tid}`, { cookie: cookieB });
    const attId = detail.data.messages[0].attachments[0].id;
    const attRes = await fetch(`${baseUrl}/api/v1/threads/attachments/${attId}`, {
      headers: { Cookie: cookieB },
    });
    assert.equal(attRes.status, 200);
    assert.equal(attRes.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((attRes.headers.get('content-security-policy') || '').includes('sandbox'));

    // 2. Verify rule update + reorder + new action mark_unread
    const rulesList = await api('/api/v1/org/rules', { cookie: cookieB });
    assert.ok(rulesList.data.rules.length >= 1);
    const ruleId = rulesList.data.rules[0].id;
    const patchRule = await api(`/api/v1/org/rules/${ruleId}`, {
      method: 'PATCH',
      cookie: cookieB,
      csrf: csrfB,
      body: {
        name: 'VIP Unread Highlighter',
        conditions: [{ field: 'is_starred', operator: 'is_true', value: '' }],
        actions: [{ type: 'mark_unread' }],
      },
    });
    assert.equal(patchRule.status, 200);
    const reorderRes = await api('/api/v1/org/rules/reorder', {
      method: 'POST',
      cookie: cookieB,
      csrf: csrfB,
      body: { ruleIds: [ruleId] },
    });
    assert.equal(reorderRes.status, 200);

    // 3. Verify quiet hours check
    const { isWithinQuietHours } = await import('../src/services/notificationService.js');
    const { DEFAULT_USER_PREFERENCES } = await import('../src/types.js');
    const qPrefs = {
      ...DEFAULT_USER_PREFERENCES,
      general: { ...DEFAULT_USER_PREFERENCES.general, timezone: 'UTC' },
      notifications: {
        ...DEFAULT_USER_PREFERENCES.notifications,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
      },
    };
    assert.equal(isWithinQuietHours(qPrefs, new Date('2026-11-26T23:30:00Z')), true);
    assert.equal(isWithinQuietHours(qPrefs, new Date('2026-11-26T14:00:00Z')), false);
  });

  it('registers real workspace cleanly with zero fake data and transmits RFC MIME over real SMTP socket', async () => {
    // 1. Default registration has NO fake emails and NO local sandbox account
    const regReal = await api('/api/v1/auth/register', {
      method: 'POST',
      body: {
        name: 'Real User',
        email: 'realuser@example.com',
        password: 'RealPassword123!',
      },
    });
    assert.equal(regReal.status, 201);
    assert.equal(regReal.data.createdAccountId, null);
    const cookieR = regReal.headers.get('set-cookie')?.split(';')[0] || '';
    const csrfR = regReal.data.csrfToken;
    const inboxR = await api('/api/v1/threads?view=inbox', { cookie: cookieR });
    assert.equal(inboxR.data.threads.length, 0);

    // 2. Runtime OAuth/AI configuration requires admin & saves keys locally without returning secrets
    const cfgBlocked = await api('/api/v1/accounts/providers/configure', {
      method: 'POST',
      cookie: cookieR,
      csrf: csrfR,
      body: {
        googleClientId: 'test-client-id',
        googleClientSecret: 'super-secret-value',
      },
    });
    assert.equal(cfgBlocked.status, 403);

    const cfgRes = await api('/api/v1/accounts/providers/configure', {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: {
        googleClientId: 'test-client-id',
        googleClientSecret: 'super-secret-value',
      },
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.data.providers.gmail.configured, true);
    assert.equal(JSON.stringify(cfgRes.data).includes('super-secret-value'), false);

    const cfgClear = await api('/api/v1/accounts/providers/configure', {
      method: 'POST',
      cookie: cookieA,
      csrf: csrfA,
      body: { clearKeys: ['google'] },
    });
    assert.equal(cfgClear.status, 200);
    assert.equal(cfgClear.data.providers.gmail.configured, false);

    // 3. Spin up a local RFC SMTP server socket and send a real MIME email via ImapSmtpAdapter
    const net = await import('node:net');
    const { ImapSmtpAdapter } = await import('../src/providers/imapSmtpAdapter.js');
    let receivedData = '';
    const smtpServer = net.createServer((socket) => {
      let inData = false;
      socket.write('220 localhost CadenceTestESMTP\r\n');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        while (true) {
          if (inData) {
            const endIdx = buf.indexOf('\r\n.\r\n');
            if (endIdx === -1) break;
            receivedData += buf.slice(0, endIdx);
            buf = buf.slice(endIdx + 5);
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            const nl = buf.indexOf('\r\n');
            if (nl === -1) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO')) {
              socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
            } else if (upper.startsWith('AUTH PLAIN')) {
              socket.write('235 2.7.0 Authentication successful\r\n');
            } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
              socket.write('250 2.1.0 Ok\r\n');
            } else if (upper === 'DATA') {
              inData = true;
              socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            } else if (upper === 'QUIT') {
              socket.write('221 2.0.0 Bye\r\n');
              socket.end();
            } else {
              socket.write('250 Ok\r\n');
            }
          }
        }
      });
    });

    await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = smtpServer.address();
    const smtpPort = addr && typeof addr === 'object' ? addr.port : 0;

    try {
      const adapter = new ImapSmtpAdapter();
      const sendRes = await adapter.sendMessage(
        {
          type: 'imap_smtp',
          imapHost: '127.0.0.1',
          imapPort: 993,
          imapSecure: true,
          smtpHost: '127.0.0.1',
          smtpPort,
          smtpSecure: false,
          username: 'realuser@example.com',
          password: 'app-password-demo',
        },
        {
          fromName: 'Real User',
          fromAddress: 'realuser@example.com',
          to: [{ name: 'Recipient', address: 'target@gmail.com' }],
          cc: [],
          bcc: [],
          subject: 'Real SMTP Wire Dispatch',
          html: '<p>Real MIME email transmitted over SMTP.</p>',
          text: 'Real MIME email transmitted over SMTP.',
          attachments: [
            { filename: 'note.txt', mimeType: 'text/plain', content: Buffer.from('Real attachment bytes') },
          ],
        }
      );
      assert.ok(sendRes.messageIdHeader);
      assert.ok(receivedData.includes('Subject: Real SMTP Wire Dispatch'));
      assert.ok(receivedData.includes('target@gmail.com'));
      assert.ok(receivedData.includes('Real MIME email transmitted over SMTP.'));
      assert.ok(receivedData.includes('note.txt'));
    } finally {
      await new Promise<void>((resolve) => smtpServer.close(() => resolve()));
    }
  });
});

describe('Hybrid Mode A: Hosted Domains, DKIM, Incoming MX, Outbound MTA, RBAC & Backups', () => {
  let adminCookie = '';
  let adminCsrf = '';
  let memberCookie = '';
  let memberCsrf = '';
  let domainId = '';
  let hostedAcctId = '';

  it('enforces admin RBAC and provisions hosted domains with real RSA-2048 DKIM & honest DNS checks', async () => {
    const loginAlice = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'alice@cadence.local', password: 'StrongPassword123!' },
    });
    assert.equal(loginAlice.status, 200);
    assert.equal(loginAlice.data.user.role, 'admin');
    adminCookie = loginAlice.headers.get('set-cookie')?.split(';')[0] || '';
    adminCsrf = loginAlice.data.csrfToken;

    const loginBob = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'bob@cadence.local', password: 'StrongPassword456!' },
    });
    assert.equal(loginBob.status, 200);
    assert.equal(loginBob.data.user.role, 'member');
    memberCookie = loginBob.headers.get('set-cookie')?.split(';')[0] || '';
    memberCsrf = loginBob.data.csrfToken;

    // Non-admin member cannot access admin endpoints
    const forbiddenOv = await api('/api/v1/admin/overview', { cookie: memberCookie });
    assert.equal(forbiddenOv.status, 403);
    const forbiddenDom = await api('/api/v1/admin/domains', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { domain: 'hack.example' },
    });
    assert.equal(forbiddenDom.status, 403);

    // Admin creates domain (never fabricates live DNS ownership verification)
    const domRes = await api('/api/v1/admin/domains', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { domain: 'mailhub.example', primaryMxHost: 'mx.mailhub.example' },
    });
    assert.equal(domRes.status, 201);
    domainId = domRes.data.domain.id;
    assert.equal(domRes.data.domain.ownershipVerified, false);
    assert.ok(domRes.data.domain.dkimPublicKey.length > 100);
    assert.equal(domRes.data.domain.status, 'pending_verification');

    // Run genuine DNS check -> stays unverified since no public DNS TXT exists
    const dnsVerify = await api(`/api/v1/admin/domains/${domainId}/verify-dns`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
    });
    assert.equal(dnsVerify.status, 200);
    assert.equal(dnsVerify.data.domain.ownershipVerified, false);
    assert.ok(dnsVerify.data.domain.dnsChecks.length >= 6);

    // Explicitly activate internal mode for platform mailbox creation
    const actRes = await api(`/api/v1/admin/domains/${domainId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { status: 'active', internalOnly: true },
    });
    assert.equal(actRes.status, 200);
    assert.equal(actRes.data.domain.status, 'active');

    // Provision hosted mailbox & alias
    const hostAcct = await api('/api/v1/accounts/hosted', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { domainId, localPart: 'ceo', displayName: 'Alice CEO', setDefault: true },
    });
    assert.equal(hostAcct.status, 201);
    hostedAcctId = hostAcct.data.accountId;

    const aliasRes = await api('/api/v1/admin/aliases', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { accountId: hostedAcctId, aliasAddress: 'founder@mailhub.example' },
    });
    assert.equal(aliasRes.status, 201);
  });

  it('operates real TCP incoming MX (blocking open relays), alias delivery, authenticated submission, and DKIM-signed outbound MTA delivery', async () => {
    const net = await import('node:net');
    const nodemailer = (await import('nodemailer')).default;
    const { config } = await import('../src/config.js');
    const { startSmtpServer } = await import('../src/smtp/smtpServer.js');
    const { processMailQueue } = await import('../src/services/mailDeliveryEngine.js');

    const mxServer = await startSmtpServer({ mode: 'mx', host: '127.0.0.1', port: 0, db: getDb() });
    const subServer = await startSmtpServer({ mode: 'submission', host: '127.0.0.1', port: 0, db: getDb() });

    // Simulated external Internet MX sink to verify real DKIM-signed outbound TCP delivery
    let capturedRemoteMime = '';
    const remoteMxSink = net.createServer((socket) => {
      let inData = false;
      let buf = '';
      socket.write('220 remote-mx.example ESMTP Ready\r\n');
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        while (true) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end === -1) break;
            capturedRemoteMime += buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            socket.write('250 2.0.0 Accepted by remote MX\r\n');
          } else {
            const nl = buf.indexOf('\r\n');
            if (nl === -1) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO')) socket.write('250-remote-mx.example\r\n250 8BITMIME\r\n');
            else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) socket.write('250 Ok\r\n');
            else if (upper === 'DATA') {
              inData = true;
              socket.write('354 Go ahead\r\n');
            } else if (upper === 'QUIT') {
              socket.write('221 Bye\r\n');
              socket.end();
            } else socket.write('250 Ok\r\n');
          }
        }
      });
    });

    await new Promise<void>((resolve) => remoteMxSink.listen(0, '127.0.0.1', () => resolve()));
    const sinkAddr = remoteMxSink.address();
    const sinkPort = sinkAddr && typeof sinkAddr === 'object' ? sinkAddr.port : 25;

    const prevOutboundPort = config.smtp.outboundMxPort;
    const prevMxOverride = process.env.CADENCE_MX_OVERRIDE_HOST;
    config.smtp.outboundMxPort = sinkPort;
    process.env.CADENCE_MX_OVERRIDE_HOST = '127.0.0.1';

    try {
      // 1. Open-relay rejection test over raw TCP on MX listener
      const relayResp = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(mxServer.port, '127.0.0.1');
        let transcript = '';
        let step = 0;
        client.on('error', reject);
        client.on('data', (d) => {
          transcript += d.toString('utf8');
          if (step === 0 && transcript.includes('220 ')) {
            step = 1;
            client.write('EHLO external.attacker.invalid\r\n');
          } else if (step === 1 && transcript.includes('250 ')) {
            step = 2;
            client.write('MAIL FROM:<spam@external.invalid>\r\n');
          } else if (step === 2 && transcript.includes('250 2.1.0')) {
            step = 3;
            client.write('RCPT TO:<victim@unrelated-external.com>\r\n');
          } else if (step === 3 && (transcript.includes('550 5.7.1') || transcript.includes('550 '))) {
            client.write('QUIT\r\n');
            client.destroy();
            resolve(transcript);
          }
        });
      });
      assert.ok(relayResp.includes('550 5.7.1'));

      // 2. Genuine incoming mail via MX listener to hosted alias founder@mailhub.example
      const mxSender = nodemailer.createTransport({ host: '127.0.0.1', port: mxServer.port, secure: false, tls: { rejectUnauthorized: false } });
      await mxSender.sendMail({
        from: '"External Sender" <sender@partner.org>',
        to: 'founder@mailhub.example',
        subject: 'Incoming SMTP Alias Delivery Verified',
        html: '<p>Delivered straight to CEO Inbox via MX port.</p>',
      });

      const ceoInbox = await api(`/api/v1/threads?view=inbox&accountId=${hostedAcctId}`, { cookie: adminCookie });
      assert.equal(ceoInbox.status, 200);
      assert.ok(ceoInbox.data.threads.some((t: any) => t.subject === 'Incoming SMTP Alias Delivery Verified'));

      // 3. Authenticated SMTP Submission -> Outbound Queue -> DKIM-Signed Delivery to remote MX sink
      const subClient = nodemailer.createTransport({
        host: '127.0.0.1',
        port: subServer.port,
        secure: false,
        tls: { rejectUnauthorized: false },
        auth: { user: 'ceo@mailhub.example', pass: 'StrongPassword123!' },
      });
      await subClient.sendMail({
        from: '"Alice CEO" <ceo@mailhub.example>',
        to: 'partner@external-recipient.org',
        subject: 'DKIM Signed Outbound MTA Test',
        text: 'This traversed submission AUTH, mail_queue, DKIM signing, and direct MX delivery.',
      });

      // Wait for both background sweep completion and remote sink / DB status transition
      for (let i = 0; i < 30; i++) {
        await processMailQueue(getDb());
        const qRow = getDb()
          .prepare("SELECT status FROM mail_queue WHERE subject = 'DKIM Signed Outbound MTA Test' ORDER BY created_at DESC LIMIT 1")
          .get() as { status: string } | undefined;
        if (capturedRemoteMime.includes('DKIM-Signature:') && qRow?.status === 'accepted_by_mx') {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(capturedRemoteMime.includes('DKIM-Signature:'), 'Expected DKIM-Signature header on outbound message');
      assert.ok(capturedRemoteMime.includes('d=mailhub.example;'));
      assert.ok(capturedRemoteMime.includes('Subject: DKIM Signed Outbound MTA Test'));

      const qRes = await api('/api/v1/admin/queue', { cookie: adminCookie });
      assert.equal(qRes.status, 200);
      assert.ok(qRes.data.queue.some((q: any) => q.subject === 'DKIM Signed Outbound MTA Test' && q.status === 'accepted_by_mx'));

      const secRes = await api('/api/v1/admin/security-events', { cookie: adminCookie });
      assert.ok(secRes.data.events.some((e: any) => e.event_type === 'smtp_relay_denied'));
    } finally {
      config.smtp.outboundMxPort = prevOutboundPort;
      if (prevMxOverride === undefined) delete process.env.CADENCE_MX_OVERRIDE_HOST;
      else process.env.CADENCE_MX_OVERRIDE_HOST = prevMxOverride;
      await mxServer.close();
      await subServer.close();
      await new Promise<void>((resolve) => remoteMxSink.close(() => resolve()));
    }
  });

  it('creates verifiable infrastructure backups that strip secrets and pass dry-run restore', async () => {
    const bakCreate = await api('/api/v1/admin/backups', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { includeAttachments: true },
    });
    assert.equal(bakCreate.status, 201);
    const bakId = bakCreate.data.backup.id;
    assert.ok(bakCreate.data.backup.checksumSha256);

    const verifyRes = await api(`/api/v1/admin/backups/${bakId}/verify`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.ok, true);
    assert.equal(verifyRes.data.checksumMatch, true);
    assert.equal(verifyRes.data.integrityResult, 'ok');

    // Verify backup snapshot stripped live sessions cleanly
    const { DatabaseSync } = await import('node:sqlite');
    const snapPath = path.join(bakCreate.data.backup.backupPath, 'cadence-snapshot.db');
    const snapDb = new DatabaseSync(snapPath, { readOnly: true });
    try {
      const sessCnt = (snapDb.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
      assert.equal(sessCnt, 0);
    } finally {
      snapDb.close();
    }

    const dryRestore = await api(`/api/v1/admin/backups/${bakId}/restore`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { dryRun: true },
    });
    assert.equal(dryRestore.status, 200);
    assert.equal(dryRestore.data.ok, true);
    assert.equal(dryRestore.data.dryRun, true);
  });
});

describe('Next-Gen Ecosystem: Tasks, Calendar, Collaboration RBAC, AI Workflows, Security & Observability', () => {
  let adminCookie = '';
  let adminCsrf = '';
  let adminUserId = '';
  let memberCookie = '';
  let memberCsrf = '';
  let memberUserId = '';
  let aliceAcctId = '';
  let bobAcctId = '';
  let bobThreadId = '';

  it('logs in workspace users and verifies saved searches, filename/size/category operators, custom categories, rule logs & generated actions', async () => {
    const loginAlice = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'alice@cadence.local', password: 'StrongPassword123!' },
    });
    assert.equal(loginAlice.status, 200);
    adminCookie = loginAlice.headers.get('set-cookie')?.split(';')[0] || '';
    adminCsrf = loginAlice.data.csrfToken;
    adminUserId = loginAlice.data.user.id;

    const loginBob = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'bob@cadence.local', password: 'StrongPassword456!' },
    });
    assert.equal(loginBob.status, 200);
    memberCookie = loginBob.headers.get('set-cookie')?.split(';')[0] || '';
    memberCsrf = loginBob.data.csrfToken;
    memberUserId = loginBob.data.user.id;

    const aliceAccts = await api('/api/v1/accounts', { cookie: adminCookie });
    aliceAcctId = aliceAccts.data.accounts.find((a: any) => a.emailAddress === 'alice@cadence.local')?.id || aliceAccts.data.accounts[0].id;
    const bobAccts = await api('/api/v1/accounts', { cookie: memberCookie });
    bobAcctId = bobAccts.data.accounts[0].id;

    // Saved search CRUD
    const ssCreate = await api('/api/v1/org/saved-searches', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { name: 'Addendum Docs', query: 'filename:addendum.txt smaller:5000' },
    });
    assert.equal(ssCreate.status, 201);
    const ssList = await api('/api/v1/org/saved-searches', { cookie: memberCookie });
    assert.ok(ssList.data.savedSearches.some((s: any) => s.name === 'Addendum Docs'));
    const savedSearchId = ssList.data.savedSearches.find((s: any) => s.name === 'Addendum Docs').id;

    // Filename & size operators
    const smallMatch = await api('/api/v1/org/search?q=' + encodeURIComponent('filename:addendum.txt smaller:5000'), { cookie: memberCookie });
    assert.equal(smallMatch.status, 200);
    assert.equal(smallMatch.data.threads.length, 1);
    bobThreadId = smallMatch.data.threads[0].id;

    const tooBigMatch = await api('/api/v1/org/search?q=' + encodeURIComponent('filename:addendum.txt larger:10mb'), { cookie: memberCookie });
    assert.equal(tooBigMatch.status, 200);
    assert.equal(tooBigMatch.data.threads.length, 0);

    const ssDel = await api(`/api/v1/org/saved-searches/${savedSearchId}`, { method: 'DELETE', cookie: memberCookie, csrf: memberCsrf });
    assert.equal(ssDel.status, 200);

    // Custom categories & category: search operator
    const catRes = await api('/api/v1/org/categories', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { name: 'Client Escalation', color: '#D97706' },
    });
    assert.equal(catRes.status, 201);
    const catId = catRes.data.category.id;
    const catSlug = catRes.data.category.slug;

    const bulkCat = await api('/api/v1/threads/bulk', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { threadIds: [bobThreadId], action: 'categorize', categorySlug: catSlug },
    });
    assert.equal(bulkCat.status, 200);

    const catSearch = await api('/api/v1/org/search?q=' + encodeURIComponent(`category:${catSlug}`), { cookie: memberCookie });
    assert.equal(catSearch.status, 200);
    assert.equal(catSearch.data.threads.length, 1);

    const delCat = await api(`/api/v1/org/categories/${catId}`, { method: 'DELETE', cookie: memberCookie, csrf: memberCsrf });
    assert.equal(delCat.status, 200);

    // Rule actions: create_task + generate_draft + rule execution logs
    const ruleRes = await api('/api/v1/org/rules', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        name: 'Alice Auto Triage',
        matchMode: 'all',
        conditions: [{ field: 'from', operator: 'contains', value: 'alice@cadence.local' }],
        actions: [
          { type: 'create_task', value: 'Review Alice addendum deliverable' },
          { type: 'generate_draft', value: 'Thank you, reviewing the addendum today.' },
        ],
      },
    });
    assert.equal(ruleRes.status, 201);
    const ruleId = ruleRes.data.id;
    const ruleRun = await api(`/api/v1/org/rules/${ruleId}/run`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
    });
    assert.equal(ruleRun.status, 200);

    const logsRes = await api('/api/v1/org/rules/logs', { cookie: memberCookie });
    assert.equal(logsRes.status, 200);
    assert.ok(logsRes.data.logs.some((l: any) => l.ruleId === ruleId && l.status === 'executed'));

    const bobTasks = await api('/api/v1/workspace/tasks?view=all', { cookie: memberCookie });
    assert.ok(bobTasks.data.tasks.some((t: any) => t.title.includes('Review Alice addendum')));
    const bobDrafts = await api('/api/v1/drafts', { cookie: memberCookie });
    assert.ok(bobDrafts.data.drafts.some((d: any) => String(d.bodyText || d.bodyHtml || '').includes('reviewing the addendum')));
  });

  it('supports Tasks lifecycle, Calendar ICS extraction & roundtrip, Attachment Library deduplication, and Multi-Signatures', async () => {
    // Tasks CRUD & completed filter
    const tCreate = await api('/api/v1/workspace/tasks', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { title: 'Finalize Q4 SLA', priority: 'high', dueAt: new Date(Date.now() + 86_400_000).toISOString(), threadId: bobThreadId },
    });
    assert.equal(tCreate.status, 201);
    const taskId = tCreate.data.id;

    const tPatch = await api(`/api/v1/workspace/tasks/${taskId}`, {
      method: 'PATCH',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { status: 'completed' },
    });
    assert.equal(tPatch.status, 200);
    const doneTasks = await api('/api/v1/workspace/tasks?view=completed', { cookie: memberCookie });
    assert.ok(doneTasks.data.tasks.some((t: any) => t.id === taskId && t.status === 'completed'));

    const tDel = await api(`/api/v1/workspace/tasks/${taskId}`, { method: 'DELETE', cookie: memberCookie, csrf: memberCsrf });
    assert.equal(tDel.status, 200);

    // Calendar extract-from-thread + create + ICS export/import + honest provider status
    const ext = await api(`/api/v1/workspace/calendar/extract-from-thread/${bobThreadId}`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
    });
    assert.equal(ext.status, 200);
    assert.ok(ext.data.candidate?.title);

    const calCreate = await api('/api/v1/workspace/calendar', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        ...ext.data.candidate,
        location: 'Boardroom B',
        attendees: [{ name: 'Alice', address: 'alice@cadence.local' }],
      },
    });
    assert.equal(calCreate.status, 201);
    const evId = calCreate.data.id;

    const icsRes = await api(`/api/v1/workspace/calendar/${evId}/ics`, { cookie: memberCookie });
    assert.equal(icsRes.status, 200);
    assert.ok(String(icsRes.data).includes('BEGIN:VCALENDAR'));
    assert.ok(String(icsRes.data).includes('BEGIN:VEVENT'));

    const icsImport = await api('/api/v1/workspace/calendar/import-ics', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { icsText: String(icsRes.data) },
    });
    assert.equal(icsImport.status, 201);
    assert.equal(icsImport.data.imported, 1);

    const calStatus = await api('/api/v1/workspace/calendar/provider-status', { cookie: memberCookie });
    assert.equal(calStatus.status, 200);
    assert.equal(calStatus.data.localCalendarReady, true);

    // Attachment Library
    const attLib = await api('/api/v1/workspace/attachments?q=addendum', { cookie: memberCookie });
    assert.equal(attLib.status, 200);
    assert.ok(attLib.data.attachments.some((a: any) => a.filename === 'addendum.txt' && a.sha256.length === 64));
    assert.ok(attLib.data.stats.totalBytes > 0);

    // Multi-Signatures CRUD & default sync
    const sigCreate = await api('/api/v1/workspace/signatures', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { accountId: aliceAcctId, name: 'Executive', bodyHtml: '<p>Best,<br>Alice Mercer</p>', isDefault: true },
    });
    assert.equal(sigCreate.status, 201);
    const sigs = await api(`/api/v1/workspace/signatures?accountId=${aliceAcctId}`, { cookie: adminCookie });
    assert.ok(sigs.data.signatures.some((s: any) => s.id === sigCreate.data.id && s.isDefault === true));
    await api(`/api/v1/workspace/signatures/${sigCreate.data.id}`, { method: 'DELETE', cookie: adminCookie, csrf: adminCsrf });
  });

  it('enforces strict tenant & role isolation for Collaboration shared mailboxes and private internal notes', async () => {
    // Member cannot share an account they do not own
    const stealAttempt = await api('/api/v1/workspace/collaboration/mailboxes', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { accountId: aliceAcctId, name: 'Unauthorized Share' },
    });
    assert.equal(stealAttempt.status, 404);

    // Alice shares her account as Support Queue
    const mbCreate = await api('/api/v1/workspace/collaboration/mailboxes', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { accountId: aliceAcctId, name: 'Support Queue', description: 'Shared customer triage' },
    });
    assert.equal(mbCreate.status, 201);
    const mbId = mbCreate.data.id;

    // Non-member Bob cannot inspect Alice's shared mailbox
    const outsiderRead = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads`, { cookie: memberCookie });
    assert.equal(outsiderRead.status, 404);

    // Alice adds Bob as viewer -> can read, but blocked (403) from modifying notes or assignments
    const addViewer = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/members`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { email: 'bob@cadence.local', role: 'viewer' },
    });
    assert.equal(addViewer.status, 201);

    const viewerThreads = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads`, { cookie: memberCookie });
    assert.equal(viewerThreads.status, 200);
    assert.ok(viewerThreads.data.threads.length >= 1);
    const targetSharedTid = viewerThreads.data.threads[0].id;

    const viewerNoteDenied = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads/${targetSharedTid}/notes`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { body: 'Viewer note blocked' },
    });
    assert.equal(viewerNoteDenied.status, 403);

    const viewerAssignDenied = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads/${targetSharedTid}/assign`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { assignedToUserId: adminUserId, status: 'pending' },
    });
    assert.equal(viewerAssignDenied.status, 403);

    // Alice upgrades Bob to agent -> can assign & post internal note (kept strictly off external message thread)
    const upgradeAgent = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/members`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { email: 'bob@cadence.local', role: 'agent' },
    });
    assert.equal(upgradeAgent.status, 201);

    const agentAssign = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads/${targetSharedTid}/assign`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { assignedToUserId: memberUserId, status: 'pending' },
    });
    assert.equal(agentAssign.status, 200);

    const agentNote = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads/${targetSharedTid}/notes`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { body: 'PRIVATE_TEAM_HANDOFF_NOTE_991' },
    });
    assert.equal(agentNote.status, 201);

    const notesList = await api(`/api/v1/workspace/collaboration/mailboxes/${mbId}/threads/${targetSharedTid}/notes`, {
      cookie: memberCookie,
    });
    assert.equal(notesList.status, 200);
    assert.ok(notesList.data.notes.some((n: any) => n.body === 'PRIVATE_TEAM_HANDOFF_NOTE_991'));

    const externalThreadDetail = await api(`/api/v1/threads/${targetSharedTid}`, { cookie: adminCookie });
    assert.equal(externalThreadDetail.status, 200);
    assert.equal(JSON.stringify(externalThreadDetail.data.messages).includes('PRIVATE_TEAM_HANDOFF_NOTE_991'), false);
  });

  it('handles Contacts deduplication/merge/CSV/vCard, Security Center, AI workflow confirmation gate, Queue idempotency & Observability', async () => {
    // Contacts duplicates, merge, activity, CSV export, vCard import
    const c1 = await api('/api/v1/productivity/contacts', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { name: 'Jordan Lee', email: 'jordan1@example.com' },
    });
    const c2 = await api('/api/v1/productivity/contacts', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { name: 'Jordan Lee', email: 'jordan2@example.com', organization: 'Acme Corp' },
    });
    assert.equal(c1.status, 201);
    assert.equal(c2.status, 201);

    const dups = await api('/api/v1/productivity/contacts/duplicates', { cookie: adminCookie });
    assert.equal(dups.status, 200);
    assert.ok(dups.data.duplicateGroups.some((g: any[]) => g.some((c) => c.name === 'Jordan Lee')));

    const c1Id = c1.data.id ?? c1.data.contact?.id;
    const c2Id = c2.data.id ?? c2.data.contact?.id;
    assert.ok(c1Id && c2Id);

    const mergeRes = await api('/api/v1/productivity/contacts/merge', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { primaryId: c1Id, duplicateId: c2Id },
    });
    assert.equal(mergeRes.status, 200);

    const contactsAfter = await api('/api/v1/productivity/contacts', { cookie: adminCookie });
    const jordan = contactsAfter.data.contacts.find((c: any) => c.id === c1Id);
    assert.ok(jordan && jordan.organization === 'Acme Corp' && jordan.notes.includes('jordan2@example.com'));

    const actRes = await api(`/api/v1/productivity/contacts/${jordan.id}/activity`, { cookie: adminCookie });
    assert.equal(actRes.status, 200);

    const csvOut = await api('/api/v1/productivity/contacts/export?format=csv', { cookie: adminCookie });
    assert.equal(csvOut.status, 200);
    assert.ok(String(csvOut.data).includes('Jordan Lee'));

    const vcardIn = await api('/api/v1/productivity/contacts/import', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { data: 'BEGIN:VCARD\nVERSION:3.0\nFN:Morgan VCard\nEMAIL:morgan@example.com\nORG:Orbit\nEND:VCARD' },
    });
    assert.ok([200, 201].includes(vcardIn.status));

    // Security Center (zero secret leakage)
    const secCenter = await api('/api/v1/auth/security-center', { cookie: adminCookie });
    assert.equal(secCenter.status, 200);
    assert.ok(secCenter.data.posture.length >= 3);
    assert.equal(JSON.stringify(secCenter.data).includes('StrongPassword123'), false);

    // Queue idempotency + dead-letter CHECK transition + observability metrics
    const { enqueueHostedOutgoingMail } = await import('../src/services/mailDeliveryEngine.js');
    const { config } = await import('../src/config.js');
    const deadPort = await allocateClosedPort();

    const prevMxPort = config.smtp.outboundMxPort;
    const prevMxHost = process.env.CADENCE_MX_OVERRIDE_HOST;
    config.smtp.outboundMxPort = deadPort;
    process.env.CADENCE_MX_OVERRIDE_HOST = '127.0.0.1';

    try {
      const db = getDb();
      const idempA = await enqueueHostedOutgoingMail(db, {
        userId: adminUserId,
        accountId: aliceAcctId,
        draftId: null,
        sentMessageId: 'sent-idemp-msg',
        messageIdHeader: '<idemp-test@cadence.local>',
        fromName: 'Alice Mercer',
        fromAddress: 'alice@cadence.local',
        to: [{ name: 'Ext', address: 'ext@nowhere-queue-test.invalid' }],
        cc: [],
        bcc: [],
        subject: 'Idempotent Queue Check',
        html: '<p>Queue test</p>',
        text: 'Queue test',
        attachments: [],
        idempotencyKey: 'fixed-idemp-key-99',
      });
      const idempB = await enqueueHostedOutgoingMail(db, {
        userId: adminUserId,
        accountId: aliceAcctId,
        draftId: null,
        sentMessageId: 'sent-idemp-msg',
        messageIdHeader: '<idemp-test@cadence.local>',
        fromName: 'Alice Mercer',
        fromAddress: 'alice@cadence.local',
        to: [{ name: 'Ext', address: 'ext@nowhere-queue-test.invalid' }],
        cc: [],
        bcc: [],
        subject: 'Idempotent Queue Check',
        html: '<p>Queue test</p>',
        text: 'Queue test',
        attachments: [],
        idempotencyKey: 'fixed-idemp-key-99',
      });
      assert.ok(idempA.queueId && idempA.queueId === idempB.queueId);

      for (let i = 0; i < 60; i++) {
        await processMailQueue(db);
        const st = (db.prepare('SELECT status FROM mail_queue WHERE id = ?').get(idempA.queueId) as { status: string }).status;
        if (st !== 'queued' && st !== 'processing') break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const dlRes = await api(`/api/v1/admin/queue/${idempA.queueId}/dead-letter`, {
        method: 'POST',
        cookie: adminCookie,
        csrf: adminCsrf,
        body: { reason: 'Manual test quarantine' },
      });
      assert.equal(dlRes.status, 200);
      const dlRow = db.prepare('SELECT status FROM mail_queue WHERE id = ?').get(idempA.queueId) as { status: string };
      assert.equal(dlRow.status, 'dead_letter');
      const delQ = await api(`/api/v1/admin/queue/${idempA.queueId}`, { method: 'DELETE', cookie: adminCookie, csrf: adminCsrf });
      assert.equal(delQ.status, 200);
    } finally {
      config.smtp.outboundMxPort = prevMxPort;
      if (prevMxHost === undefined) delete process.env.CADENCE_MX_OVERRIDE_HOST;
      else process.env.CADENCE_MX_OVERRIDE_HOST = prevMxHost;
    }

    const db = getDb();

    const metricsDenied = await api('/api/v1/admin/metrics', { cookie: memberCookie });
    assert.equal(metricsDenied.status, 403);
    const metricsOk = await api('/api/v1/admin/metrics', { cookie: adminCookie });
    assert.equal(metricsOk.status, 200);
    assert.ok(metricsOk.data.metrics.totalRequests > 0);
    assert.ok(metricsOk.data.metrics.memoryRssMb > 0);

    // Bounded AI Search + Workflow confirmation gate (never auto-sends)
    await api('/api/v1/productivity/preferences', {
      method: 'PATCH',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { ai: { enabled: true, privacyDisclosureAccepted: true } },
    });

    const aiSearch = await api('/api/v1/productivity/ai/search', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { query: 'Find emails from Alice about addendum' },
    });
    assert.equal(aiSearch.status, 200);
    assert.ok(aiSearch.data.answer);
    assert.ok(aiSearch.data.threads.length >= 1);

    const queueCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM mail_queue').get() as { c: number }).c;
    const wfPlan = await api('/api/v1/productivity/ai/workflow/plan', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { prompt: 'Create a follow-up task and draft a reply', threadId: bobThreadId },
    });
    assert.equal(wfPlan.status, 201);
    assert.equal(wfPlan.data.run.status, 'awaiting_confirmation');
    assert.ok(wfPlan.data.run.plan.length >= 1);

    const wfExec = await api(`/api/v1/productivity/ai/workflow/${wfPlan.data.run.id}/execute`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
    });
    assert.equal(wfExec.status, 200);
    const queueCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM mail_queue').get() as { c: number }).c;
    assert.equal(queueCountAfter, queueCountBefore);

    const wfPlan2 = await api('/api/v1/productivity/ai/workflow/plan', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { prompt: 'Create task to archive later', threadId: bobThreadId },
    });
    const wfCancel = await api(`/api/v1/productivity/ai/workflow/${wfPlan2.data.run.id}/cancel`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
    });
    assert.equal(wfCancel.status, 200);
    const wfHist = await api('/api/v1/productivity/ai/workflow/history', { cookie: memberCookie });
    assert.ok(wfHist.data.runs.some((r: any) => r.id === wfPlan.data.run.id && r.status === 'executed'));
    assert.ok(wfHist.data.runs.some((r: any) => r.id === wfPlan2.data.run.id && r.status === 'cancelled'));
  });

  it('reads shared mailbox conversation messages & attachments, enforces retention purge, and blocks RFC mailing-list rule loops', async () => {
    // 1. Collaboration shared conversation reader & scoped attachment download
    const mbs = await api('/api/v1/workspace/collaboration/mailboxes', { cookie: memberCookie });
    assert.equal(mbs.status, 200);
    const sharedMb = mbs.data.mailboxes.find((m: any) => m.name === 'Support Queue');
    assert.ok(sharedMb);

    const sharedList = await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/threads`, { cookie: memberCookie });
    const sharedTid = sharedList.data.threads[0].id;

    // Private endpoint remains strictly blocked (404), while shared conversation reader succeeds (200)
    const privDeny = await api(`/api/v1/threads/${sharedTid}`, { cookie: memberCookie });
    assert.equal(privDeny.status, 404);

    const sharedDetail = await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/threads/${sharedTid}`, {
      cookie: memberCookie,
    });
    assert.equal(sharedDetail.status, 200);
    assert.ok(sharedDetail.data.messages.length >= 1);
    const msgWithAtt = sharedDetail.data.messages.find((m: any) => m.attachments && m.attachments.length > 0);
    if (msgWithAtt) {
      const attRes = await api(
        `/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/attachments/${msgWithAtt.attachments[0].id}`,
        { cookie: memberCookie }
      );
      assert.equal(attRes.status, 200);
      assert.equal(attRes.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    }

    // 2. Retention Policy enforcement on aged Trash/Spam messages without touching Inbox
    const { ingestMessage } = await import('../src/services/threadService.js');
    const db = getDb();
    const oldTrash = ingestMessage(
      db,
      adminUserId,
      aliceAcctId,
      {
        remoteId: 'aged-trash-item-1',
        messageIdHeader: '<aged-trash@cadence.local>',
        fromName: 'Spammer',
        fromAddress: 'spammer@junk.example',
        to: [{ name: 'Alice', address: 'alice@cadence.local' }],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: 'Old Trash Candidate',
        rawHtml: '<p>To be purged by retention policy.</p>',
        rawText: 'To be purged by retention policy.',
        receivedAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
        isTrash: true,
        isSpam: false,
        isRead: true,
        isStarred: false,
        isImportant: false,
        isDraft: false,
        isArchived: false,
        attachments: [],
      },
      { skipNotifications: true, skipRules: true }
    );
    assert.equal(oldTrash.inserted, true);

    const inboxCountBefore = (
      db.prepare('SELECT COUNT(*) AS c FROM threads WHERE user_id = ? AND in_inbox = 1').get(adminUserId) as { c: number }
    ).c;

    const purgeRes = await api('/api/v1/threads/retention/purge', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
    });
    assert.equal(purgeRes.status, 200);
    assert.ok(purgeRes.data.deletedMessages >= 1);
    const goneThread = db.prepare('SELECT id FROM threads WHERE id = ?').get(oldTrash.threadId);
    assert.equal(goneThread, undefined);
    const inboxCountAfter = (
      db.prepare('SELECT COUNT(*) AS c FROM threads WHERE user_id = ? AND in_inbox = 1').get(adminUserId) as { c: number }
    ).c;
    assert.equal(inboxCountAfter, inboxCountBefore);

    // 3. RFC 3834 Auto-Submitted & List-Unsubscribe loop guard on auto_reply rule
    const autoRule = await api('/api/v1/org/rules', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        name: 'Auto Reply RFC Guard Test',
        matchMode: 'all',
        conditions: [{ field: 'subject', operator: 'contains', value: 'Digest Loop Test' }],
        actions: [{ type: 'auto_reply', value: 'OOO reply should be skipped' }],
      },
    });
    assert.equal(autoRule.status, 201);
    const autoRuleId = autoRule.data.id;

    const draftsBefore = db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE user_id = ? AND subject LIKE '[Auto-Reply]%'").get(memberUserId) as { c: number };
    const listMail = ingestMessage(
      db,
      memberUserId,
      bobAcctId,
      {
        remoteId: 'rfc-loop-msg-1',
        messageIdHeader: '<rfc-loop@partner.example>',
        fromName: 'Partner Newsletter',
        fromAddress: 'human-editor@partner.example',
        to: [{ name: 'Bob', address: 'bob@cadence.local' }],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: 'Weekly Digest Loop Test #42',
        rawHtml: '<p>Newsletter body.</p>',
        rawText: 'Newsletter body.',
        rawHeaders: {
          'Auto-Submitted': 'auto-generated',
          'List-Unsubscribe': '<mailto:unsub@partner.example>',
        },
        isRead: false,
        isStarred: false,
        isImportant: false,
        isDraft: false,
        isSpam: false,
        isTrash: false,
        isArchived: false,
        attachments: [],
      },
      { skipNotifications: true }
    );
    assert.equal(listMail.inserted, true);

    const draftsAfter = db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE user_id = ? AND subject LIKE '[Auto-Reply]%'").get(memberUserId) as { c: number };
    assert.equal(draftsAfter.c, draftsBefore.c);

    const ruleLogs = db
      .prepare('SELECT status, detail FROM rule_execution_logs WHERE rule_id = ? AND message_id = ?')
      .all(autoRuleId, listMail.messageId) as Array<{ status: string; detail: string }>;
    assert.equal(ruleLogs.length, 1);
    assert.equal(ruleLogs[0].status, 'skipped_guard');
    assert.ok(ruleLogs[0].detail.includes('Auto-Submitted'));
  });

  it('sends Team Desk shared replies (blocking viewers), empties Trash cleanly, and surfaces List-Unsubscribe metadata', async () => {
    // 1. Verify List-Unsubscribe header extraction in GET /threads/:id
    const db = getDb();
    const bobThreads = await api('/api/v1/threads?view=inbox', { cookie: memberCookie });
    const digestThread = bobThreads.data.threads.find((t: any) => String(t.subject).includes('Digest Loop Test'));
    assert.ok(digestThread);
    const digestDetail = await api(`/api/v1/threads/${digestThread.id}`, { cookie: memberCookie });
    assert.equal(digestDetail.status, 200);
    assert.equal(digestDetail.data.messages[0].listUnsubscribe?.mailto, 'unsub@partner.example');

    // 2. Team Desk Shared Reply RBAC & delivery
    const mbs = await api('/api/v1/workspace/collaboration/mailboxes', { cookie: memberCookie });
    const sharedMb = mbs.data.mailboxes.find((m: any) => m.name === 'Support Queue');
    assert.ok(sharedMb);
    const sharedList = await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/threads`, { cookie: memberCookie });
    const sharedTid = sharedList.data.threads[0].id;

    // Downgrade Bob temporarily to viewer -> reply must return 403
    await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/members`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { email: 'bob@cadence.local', role: 'viewer' },
    });
    const viewerReplyDenied = await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/threads/${sharedTid}/reply`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { text: 'Viewer reply should fail' },
    });
    assert.equal(viewerReplyDenied.status, 403);

    // Restore Bob to agent -> shared reply succeeds and logs team audit note
    await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/members`, {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { email: 'bob@cadence.local', role: 'agent' },
    });
    const agentReplyOk = await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/threads/${sharedTid}/reply`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { text: 'Team Desk response sent on behalf of Support Queue.' },
    });
    assert.equal(agentReplyOk.status, 200);
    assert.equal(agentReplyOk.data.ok, true);

    const updatedNotes = await api(`/api/v1/workspace/collaboration/mailboxes/${sharedMb.id}/threads/${sharedTid}/notes`, {
      cookie: memberCookie,
    });
    assert.ok(updatedNotes.data.notes.some((n: any) => String(n.body).includes('Sent shared reply')));

    // 3. Empty Trash folder cleanly without disturbing active Inbox
    const { ingestMessage } = await import('../src/services/threadService.js');
    const tempTrash = ingestMessage(
      db,
      memberUserId,
      bobAcctId,
      {
        remoteId: 'empty-trash-1',
        messageIdHeader: '<empty-trash@cadence.local>',
        fromName: 'Temp',
        fromAddress: 'temp@junk.example',
        to: [{ name: 'Bob', address: 'bob@cadence.local' }],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: 'Immediate Trash Clear Target',
        rawHtml: '<p>Erase me</p>',
        rawText: 'Erase me',
        isTrash: true,
        isSpam: false,
        isRead: true,
        isStarred: false,
        isImportant: false,
        isDraft: false,
        isArchived: false,
        attachments: [],
      },
      { skipNotifications: true, skipRules: true }
    );
    assert.equal(tempTrash.inserted, true);

    const emptyRes = await api('/api/v1/threads/folder/empty', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { folder: 'trash' },
    });
    assert.equal(emptyRes.status, 200);
    assert.ok(emptyRes.data.deletedMessages >= 1);
    const trashLeft = await api('/api/v1/threads?view=trash', { cookie: memberCookie });
    assert.equal(trashLeft.data.threads.length, 0);
  });

  it('enforces admin RBAC on runtime provider config, supports clearKeys & calendar OAuth scopes, and guards credential updates', async () => {
    const db = getDb();

    // Non-admin member cannot mutate server-wide OAuth / AI configuration
    const memberCfg = await api('/api/v1/accounts/providers/configure', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { openaiApiKey: 'sk-unauthorized-attempt' },
    });
    assert.equal(memberCfg.status, 403);

    const memberStatus = await api('/api/v1/accounts/providers/status', { cookie: memberCookie });
    assert.equal(memberStatus.status, 200);
    assert.equal(memberStatus.data.canConfigureServerProviders, false);

    // Admin can configure & clear keys atomically, and request optional Calendar OAuth scope
    const adminCfg = await api('/api/v1/accounts/providers/configure', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: {
        googleClientId: 'test-client-id.apps.googleusercontent.com',
        googleClientSecret: 'test-client-secret',
        openaiApiKey: 'sk-test-1234567890abcdef',
        openaiModel: 'gpt-4o-mini',
        openaiBaseUrl: 'https://api.openai.com/v1',
      },
    });
    assert.equal(adminCfg.status, 200);
    assert.equal(adminCfg.data.providers.gmail.configured, true);
    assert.equal(adminCfg.data.ai.providersConfigured.openai, true);

    const oauthStartWithCal = await api('/api/v1/accounts/oauth/gmail/start?includeCalendar=true', {
      cookie: memberCookie,
    });
    assert.equal(oauthStartWithCal.status, 200);
    assert.ok(String(oauthStartWithCal.data.authUrl).includes('calendar.readonly'));

    const adminClear = await api('/api/v1/accounts/providers/configure', {
      method: 'POST',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { clearKeys: ['google', 'openai'] },
    });
    assert.equal(adminClear.status, 200);
    assert.equal(adminClear.data.providers.gmail.configured, false);
    assert.equal(adminClear.data.ai.providersConfigured.openai, false);

    // PATCH /accounts/:id/credentials validates ownership & IMAP reachability without losing stored config
    const bobHostedUpd = await api(`/api/v1/accounts/${bobAcctId}/credentials`, {
      method: 'PATCH',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { password: 'new-password' },
    });
    assert.equal(bobHostedUpd.status, 400);

    const bobExternalId = 'acct-bob-ext-imap-test';
    const now = new Date().toISOString();
    const initialCreds = encryptSecret(
      JSON.stringify({
        type: 'imap_smtp',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
        username: 'bob@example.com',
        password: 'old-app-password',
      })
    );
    db.prepare(
      `INSERT INTO accounts (id, user_id, provider_type, account_ownership, email_address, display_name, avatar_color, signature_html, signature_enabled, status, capabilities_json, encrypted_credentials, sync_cursor, notification_prefs_json, created_at, updated_at)
       VALUES (?, ?, 'imap_smtp', 'external', 'bob@example.com', 'Bob Ext', '#0F766E', '', 1, 'auth_expired', '{}', ?, '', '{}', ?, ?)`
    ).run(bobExternalId, memberUserId, initialCreds, now, now);

    // Other user (adminCookie) cannot access Bob's account credentials
    const crossUserUpd = await api(`/api/v1/accounts/${bobExternalId}/credentials`, {
      method: 'PATCH',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: { password: 'hijack-attempt' },
    });
    assert.equal(crossUserUpd.status, 404);

    // Unreachable IMAP endpoint fails verification (400) and leaves previous encrypted credentials intact
    const failedVerify = await api(`/api/v1/accounts/${bobExternalId}/credentials`, {
      method: 'PATCH',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: { imapHost: '127.0.0.1', imapPort: 1, smtpHost: '127.0.0.1', smtpPort: 1, password: 'bad-password' },
    });
    assert.equal(failedVerify.status, 400);
    const unchanged = db.prepare('SELECT encrypted_credentials FROM accounts WHERE id = ?').get(bobExternalId) as {
      encrypted_credentials: string;
    };
    assert.equal(unchanged.encrypted_credentials, initialCreds);
  });

  it('runs recurring 05:00 AM scheduled mail with attachments, keyword Google Maps location auto-replies, and shared info vault', async () => {
    const db = getDb();
    const { config } = await import('../src/config.js');
    const deadPort = await allocateClosedPort();

    const prevMxPort = config.smtp.outboundMxPort;
    const prevMxHost = process.env.CADENCE_MX_OVERRIDE_HOST;
    config.smtp.outboundMxPort = deadPort;
    process.env.CADENCE_MX_OVERRIDE_HOST = '127.0.0.1';

    try {

    // 1. Upload reusable automation file to Vault & verify sandboxed download headers
    const assetUpload = await api('/api/v1/automations/assets', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        name: 'Directions Sheet',
        filename: 'office-brochure.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Office Guide\nGate B open 9 AM - 6 PM').toString('base64'),
      },
    });
    assert.equal(assetUpload.status, 201);
    const assetId = assetUpload.data.asset.id;

    const dlRes = await fetch(`${baseUrl}/api/v1/automations/assets/${assetId}`, {
      headers: { Cookie: memberCookie },
    });
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(await dlRes.text(), 'Office Guide\nGate B open 9 AM - 6 PM');

    // 2. Save Google Maps Location card bundled with vault attachment
    const locCreate = await api('/api/v1/automations/info', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        kind: 'location',
        title: 'Main Studio Location',
        mapQuery: '22.5726,88.3639',
        contentText: '2nd Floor, Ring bell #4',
        attachmentIds: [assetId],
      },
    });
    assert.equal(locCreate.status, 201);
    const locId = locCreate.data.profile.id;
    assert.ok(String(locCreate.data.profile.effectiveMapUrl).includes('google.com/maps/search/?api=1&query=22.5726%2C88.3639'));

    // 3. Keyword rule ("contains_any" + auto_reply + {{google_map_location}} + attachment cloning)
    const locRuleRes = await api('/api/v1/org/rules', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        name: 'Share Google Maps on Location Ask',
        matchMode: 'any',
        conditions: [
          { field: 'keywords', operator: 'contains_any', value: 'location, google map, directions' },
        ],
        actions: [
          {
            type: 'auto_reply',
            value: 'Hi {{from_name}},\n\nHere is my Google Maps location:\n{{google_map_location}}',
            infoProfileIds: [locId],
            attachmentIds: [assetId],
          },
        ],
      },
    });
    assert.equal(locRuleRes.status, 201);

    const { ingestMessage } = await import('../src/services/threadService.js');
    const incomingAsk = ingestMessage(
      db,
      memberUserId,
      bobAcctId,
      {
        remoteId: 'loc-ask-1',
        messageIdHeader: '<loc-ask-1@guest.example>',
        fromName: 'Sam Visitor',
        fromAddress: 'visitor@guest.example',
        to: [{ name: 'Bob', address: 'bob@cadence.local' }],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: 'Can you share your directions?',
        rawHtml: '<p>Hi, please send your office location.</p>',
        rawText: 'Hi, please send your office location.',
        isRead: false,
        isStarred: false,
        isImportant: false,
        isDraft: false,
        isSpam: false,
        isTrash: false,
        isArchived: false,
        attachments: [],
      },
      { skipNotifications: true }
    );
    assert.equal(incomingAsk.inserted, true);

    await processDueBackgroundJobs(db);

    const autoReplySentMsg = db
      .prepare("SELECT id, body_text, body_html_sanitized, has_attachments FROM messages WHERE user_id = ? AND in_reply_to = '<loc-ask-1@guest.example>' LIMIT 1")
      .get(memberUserId) as { id: string; body_text: string; body_html_sanitized: string; has_attachments: number } | undefined;
    assert.ok(autoReplySentMsg);
    assert.ok(autoReplySentMsg.body_text.includes('google.com/maps/search/?api=1&query=22.5726%2C88.3639'));
    assert.ok(autoReplySentMsg.body_html_sanitized.includes('<a href="https://www.google.com/maps'));
    assert.equal(autoReplySentMsg.has_attachments, 1);

    const replyAtts = db
      .prepare('SELECT filename FROM attachments WHERE message_id = ?')
      .all(autoReplySentMsg.id) as Array<{ filename: string }>;
    assert.equal(replyAtts.length, 1);
    assert.equal(replyAtts[0].filename, 'office-brochure.txt');

    // 4. Recurring Scheduled Automation (daily 05:00 AM Asia/Kolkata + attachment + Send Now + Worker Run)
    const schedCreate = await api('/api/v1/automations/scheduled', {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
      body: {
        accountId: bobAcctId,
        name: 'Daily 5 AM Greeting',
        frequency: 'daily',
        timeOfDay: '05:00',
        timezone: 'Asia/Kolkata',
        to: [{ name: 'Bob Self', address: 'bob@cadence.local' }],
        subject: 'Hi — Daily Check-in {{date}}',
        bodyText: 'Hi,\n\nAttached today brochure & {{google_map_location}}',
        infoProfileIds: [locId],
        attachmentIds: [assetId],
      },
    });
    assert.equal(schedCreate.status, 201);
    const schedId = schedCreate.data.automation.id;
    const nextRunDate = new Date(schedCreate.data.automation.nextRunAt);
    assert.ok(nextRunDate.getTime() > Date.now());
    // 05:00 Asia/Kolkata (UTC+05:30) is always 23:30 UTC
    assert.equal(nextRunDate.getUTCHours(), 23);
    assert.equal(nextRunDate.getUTCMinutes(), 30);

    // Manual Run Now test
    const manualRun = await api(`/api/v1/automations/scheduled/${schedId}/run`, {
      method: 'POST',
      cookie: memberCookie,
      csrf: memberCsrf,
    });
    assert.equal(manualRun.status, 200);
    assert.equal(manualRun.data.ok, true);
    assert.equal(manualRun.data.attachedFiles, 1);

    // Simulate due scheduled window -> background worker claims, dispatches & advances next_run_at
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    db.prepare('UPDATE scheduled_automations SET next_run_at = ? WHERE id = ?').run(pastIso, schedId);
    await processDueBackgroundJobs(db);

    const listAfter = await api('/api/v1/automations/scheduled', { cookie: memberCookie });
    const updatedSched = listAfter.data.automations.find((x: any) => x.id === schedId);
    assert.ok(updatedSched);
    assert.equal(updatedSched.runCount, 2);
    assert.ok(new Date(updatedSched.nextRunAt).getTime() > Date.now());
    assert.ok(listAfter.data.logs.some((l: any) => l.automationId === schedId && l.status === 'sent'));
    await waitForMailQueueIdle();
    } finally {
      config.smtp.outboundMxPort = prevMxPort;
      if (prevMxHost === undefined) delete process.env.CADENCE_MX_OVERRIDE_HOST;
      else process.env.CADENCE_MX_OVERRIDE_HOST = prevMxHost;
    }
  });
});
