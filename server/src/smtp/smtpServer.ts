import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import type { DatabaseSync } from 'node:sqlite';
import { simpleParser, type AddressObject } from 'mailparser';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { verifyPassword } from '../security/crypto.js';
import { sanitizeEmailContent } from '../security/sanitize.js';
import {
  enqueueHostedOutgoingMail,
  findHostedRecipientAccounts,
  isDomainHostedHere,
  recomputeAccountUsageBytes,
} from '../services/mailDeliveryEngine.js';
import { recordSecurityEvent } from '../services/securityLogService.js';
import { ingestMessage } from '../services/threadService.js';
import type { EmailParticipant } from '../types.js';

const MAX_SMTP_MESSAGE_BYTES = 25 * 1024 * 1024;

export interface SmtpServerHandle {
  server: net.Server;
  mode: 'mx' | 'submission';
  host: string;
  port: number;
  tlsEnabled: boolean;
  close(): Promise<void>;
}

interface SmtpSessionState {
  helo: string;
  tlsUpgraded: boolean;
  authUserId: string | null;
  authEmail: string | null;
  authStep: null | 'await_user' | 'await_pass';
  authPendingUser: string;
  mailFrom: string | null;
  rcptTo: string[];
  inData: boolean;
  dataLines: string[];
  dataBytes: number;
}

function normalizeSmtpAddress(arg: string): string {
  const m = arg.match(/<([^>]+)>/);
  const raw = (m ? m[1] : arg).trim().replace(/^:/, '').trim();
  const spaceIdx = raw.indexOf(' ');
  return (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).trim().toLowerCase();
}

function parseAddressObj(obj: AddressObject | AddressObject[] | undefined): EmailParticipant[] {
  if (!obj) return [];
  const items = Array.isArray(obj) ? obj : [obj];
  const out: EmailParticipant[] = [];
  for (const item of items) {
    for (const v of item.value || []) {
      if (v.address) out.push({ name: v.name || '', address: v.address });
    }
  }
  return out;
}

function loadTlsOptions(): tls.TlsOptions | null {
  if (!config.smtp.tlsCertPath || !config.smtp.tlsKeyPath) return null;
  if (!fs.existsSync(config.smtp.tlsCertPath) || !fs.existsSync(config.smtp.tlsKeyPath)) return null;
  return {
    cert: fs.readFileSync(config.smtp.tlsCertPath),
    key: fs.readFileSync(config.smtp.tlsKeyPath),
  };
}

function authenticateSubmissionCredentials(
  db: DatabaseSync,
  username: string,
  password: string
): { userId: string; email: string } | null {
  const cleanUser = username.trim().toLowerCase();
  if (!cleanUser || !password) return null;

  const user = db
    .prepare('SELECT id, email, password_hash, status FROM users WHERE lower(email) = lower(?)')
    .get(cleanUser) as { id: string; email: string; password_hash: string; status: string } | undefined;

  if (user && user.status === 'active' && verifyPassword(password, user.password_hash)) {
    return { userId: user.id, email: user.email };
  }

  // Also check if username matches a hosted mailbox address owned by the user
  const acct = db
    .prepare(
      `SELECT u.id AS userId, u.password_hash, u.status, a.email_address AS email
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.provider_type IN ('hosted', 'local') AND lower(a.email_address) = lower(?)`
    )
    .get(cleanUser) as { userId: string; password_hash: string; status: string; email: string } | undefined;

  if (acct && acct.status === 'active' && verifyPassword(password, acct.password_hash)) {
    return { userId: acct.userId, email: acct.email };
  }

  return null;
}

function evaluateInboundAuthAndSpam(
  rawAuthResultsHeader: string,
  fromAddr: string,
  subject: string,
  html: string,
  text: string
): { spf: string; dkim: string; dmarc: string; isSpam: boolean; spamReason: string } {
  const lowerHdr = rawAuthResultsHeader.toLowerCase();
  const spfMatch = lowerHdr.match(/\bspf=(pass|fail|softfail|neutral|none|temperror|permerror)/);
  const dkimMatch = lowerHdr.match(/\bdkim=(pass|fail|neutral|none|temperror|permerror)/);
  const dmarcMatch = lowerHdr.match(/\bdmarc=(pass|fail|bestguesspass|none)/);

  const spf = spfMatch ? spfMatch[1] : 'none';
  const dkim = dkimMatch ? dkimMatch[1] : 'none';
  const dmarc = dmarcMatch ? dmarcMatch[1] : 'none';

  let spamScore = 0;
  const reasons: string[] = [];
  if (spf === 'fail') {
    spamScore += 2;
    reasons.push('SPF hard fail');
  }
  if (dkim === 'fail') {
    spamScore += 2;
    reasons.push('DKIM verification failed');
  }
  if (dmarc === 'fail') {
    spamScore += 3;
    reasons.push('DMARC policy failed');
  }

  const sanitized = sanitizeEmailContent(html, text);
  if (sanitized.suspiciousLinks.length >= 2) {
    spamScore += 2;
    reasons.push('Multiple suspicious phishing links');
  }
  if (/\b(viagra|lottery winner|wire transfer urgently|verify your wallet seed)\b/i.test(`${subject} ${text}`)) {
    spamScore += 3;
    reasons.push('Spam content heuristic');
  }

  const fromDomain = (fromAddr.split('@')[1] || '').toLowerCase();
  if (!fromDomain) {
    spamScore += 2;
    reasons.push('Malformed sender domain');
  }

  return {
    spf,
    dkim,
    dmarc,
    isSpam: spamScore >= 4,
    spamReason: reasons.join('; '),
  };
}

export async function startSmtpServer(opts: {
  mode: 'mx' | 'submission';
  host: string;
  port: number;
  db?: DatabaseSync;
}): Promise<SmtpServerHandle> {
  const db = opts.db || getDb();
  const tlsOpts = loadTlsOptions();
  const hostname = config.smtp.publicHostname || 'mail.localhost';

  const attachSocketHandlers = (socket: net.Socket, alreadyTls: boolean) => {
    let activeSocket: net.Socket = socket;
    const remoteIp = socket.remoteAddress || 'unknown';
    const state: SmtpSessionState = {
      helo: '',
      tlsUpgraded: alreadyTls,
      authUserId: null,
      authEmail: null,
      authStep: null,
      authPendingUser: '',
      mailFrom: null,
      rcptTo: [],
      inData: false,
      dataLines: [],
      dataBytes: 0,
    };

    const writeLine = (line: string) => {
      try {
        if (!activeSocket.destroyed) {
          activeSocket.write(`${line}\r\n`);
        }
      } catch {
        // ignore closed socket
      }
    };

    let buffer = '';
    const processLine = async (rawLine: string) => {
      if (state.inData) {
        if (rawLine === '.') {
          state.inData = false;
          const rawMime = state.dataLines.join('\r\n');
          state.dataLines = [];
          const payloadSize = state.dataBytes;
          state.dataBytes = 0;

          try {
            if (opts.mode === 'submission') {
              await handleSubmissionData(db, state, rawMime, remoteIp, writeLine);
            } else {
              await handleIncomingMxData(db, state, rawMime, payloadSize, remoteIp, writeLine);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Internal mail processing error';
            writeLine(`451 4.3.0 Temporary local problem: ${msg.replace(/[\r\n]/g, ' ')}`);
          }
          state.mailFrom = null;
          state.rcptTo = [];
          return;
        }

        const unstuffed = rawLine.startsWith('..') ? rawLine.slice(1) : rawLine;
        const lineBytes = Buffer.byteLength(unstuffed, 'utf8') + 2;
        if (state.dataBytes + lineBytes > MAX_SMTP_MESSAGE_BYTES) {
          state.inData = false;
          state.dataLines = [];
          state.dataBytes = 0;
          writeLine('552 5.3.4 Message size exceeds fixed maximum message size (25 MB)');
          return;
        }
        state.dataBytes += lineBytes;
        state.dataLines.push(unstuffed);
        return;
      }

      if (state.authStep === 'await_user') {
        state.authPendingUser = Buffer.from(rawLine.trim(), 'base64').toString('utf8');
        state.authStep = 'await_pass';
        writeLine('334 UGFzc3dvcmQ6'); // base64("Password:")
        return;
      }

      if (state.authStep === 'await_pass') {
        const pass = Buffer.from(rawLine.trim(), 'base64').toString('utf8');
        state.authStep = null;
        const authRes = authenticateSubmissionCredentials(db, state.authPendingUser, pass);
        state.authPendingUser = '';
        if (!authRes) {
          recordSecurityEvent(
            { eventType: 'smtp_auth_failed', severity: 'warning', actorEmail: '', ipAddress: remoteIp, details: { mode: opts.mode } },
            db
          );
          writeLine('535 5.7.8 Authentication credentials invalid');
          return;
        }
        state.authUserId = authRes.userId;
        state.authEmail = authRes.email;
        writeLine('235 2.7.0 Authentication successful');
        return;
      }

      const spIdx = rawLine.indexOf(' ');
      const verb = (spIdx === -1 ? rawLine : rawLine.slice(0, spIdx)).trim().toUpperCase();
      const rest = (spIdx === -1 ? '' : rawLine.slice(spIdx + 1)).trim();

      switch (verb) {
        case 'EHLO': {
          state.helo = rest || remoteIp;
          writeLine(`250-${hostname} Hello ${state.helo}`);
          writeLine(`250-SIZE ${MAX_SMTP_MESSAGE_BYTES}`);
          writeLine('250-8BITMIME');
          writeLine('250-SMTPUTF8');
          if (tlsOpts && !state.tlsUpgraded) {
            writeLine('250-STARTTLS');
          }
          if (opts.mode === 'submission') {
            writeLine('250 AUTH PLAIN LOGIN');
          } else {
            writeLine('250 HELP');
          }
          return;
        }
        case 'HELO': {
          state.helo = rest || remoteIp;
          writeLine(`250 ${hostname} Hello ${state.helo}`);
          return;
        }
        case 'STARTTLS': {
          if (!tlsOpts || state.tlsUpgraded) {
            writeLine('454 4.7.0 TLS not available on this listener');
            return;
          }
          writeLine('220 2.0.0 Ready to start TLS');
          const pausedData = buffer;
          buffer = '';
          const tlsSocket = new tls.TLSSocket(activeSocket, { ...tlsOpts, isServer: true });
          activeSocket.removeAllListeners('data');
          activeSocket = tlsSocket;
          state.tlsUpgraded = true;
          wireDataStream(tlsSocket);
          if (pausedData) tlsSocket.emit('data', Buffer.from(pausedData, 'utf8'));
          return;
        }
        case 'AUTH': {
          if (opts.mode !== 'submission') {
            writeLine('502 5.5.1 AUTH only accepted on authenticated submission port');
            return;
          }
          const parts = rest.split(/\s+/);
          const mech = (parts[0] || '').toUpperCase();
          if (mech === 'PLAIN') {
            const b64 = parts[1] || '';
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            const segs = decoded.split('\0');
            const user = segs.length >= 3 ? segs[1] : segs[0];
            const pass = segs.length >= 3 ? segs[2] : segs[1] || '';
            const authRes = authenticateSubmissionCredentials(db, user || '', pass || '');
            if (!authRes) {
              recordSecurityEvent(
                { eventType: 'smtp_auth_failed', severity: 'warning', actorEmail: user || '', ipAddress: remoteIp },
                db
              );
              writeLine('535 5.7.8 Authentication credentials invalid');
              return;
            }
            state.authUserId = authRes.userId;
            state.authEmail = authRes.email;
            writeLine('235 2.7.0 Authentication successful');
            return;
          }
          if (mech === 'LOGIN') {
            state.authStep = 'await_user';
            writeLine('334 VXNlcm5hbWU6'); // base64("Username:")
            return;
          }
          writeLine('504 5.5.4 Unrecognized authentication type');
          return;
        }
        case 'MAIL': {
          if (opts.mode === 'submission' && !state.authUserId) {
            writeLine('530 5.7.0 Authentication required');
            return;
          }
          const fromMatch = rest.match(/^FROM:\s*(.+)$/i);
          if (!fromMatch) {
            writeLine('501 5.5.4 Syntax: MAIL FROM:<address>');
            return;
          }
          const addr = normalizeSmtpAddress(fromMatch[1]);
          if (opts.mode === 'submission' && state.authUserId) {
            const ownsSender = db
              .prepare(
                `SELECT id FROM accounts WHERE user_id = ? AND provider_type IN ('hosted', 'local') AND lower(email_address) = lower(?)
                 UNION
                 SELECT id FROM mailbox_aliases WHERE user_id = ? AND lower(alias_address) = lower(?)`
              )
              .get(state.authUserId, addr, state.authUserId, addr);
            if (!ownsSender) {
              writeLine('553 5.7.1 Sender address rejected: not owned by authenticated user');
              return;
            }
          }
          state.mailFrom = addr;
          state.rcptTo = [];
          writeLine('250 2.1.0 Ok');
          return;
        }
        case 'RCPT': {
          if (state.mailFrom === null) {
            writeLine('503 5.5.1 Need MAIL command first');
            return;
          }
          const rcptMatch = rest.match(/^TO:\s*(.+)$/i);
          if (!rcptMatch) {
            writeLine('501 5.5.4 Syntax: RCPT TO:<address>');
            return;
          }
          const rcptAddr = normalizeSmtpAddress(rcptMatch[1]);
          if (!rcptAddr || !rcptAddr.includes('@')) {
            writeLine('501 5.1.3 Bad recipient address syntax');
            return;
          }
          if (opts.mode === 'mx') {
            const rcptDomain = rcptAddr.split('@')[1] || '';
            if (!isDomainHostedHere(db, rcptDomain)) {
              recordSecurityEvent(
                {
                  eventType: 'smtp_relay_denied',
                  severity: 'warning',
                  actorEmail: state.mailFrom,
                  ipAddress: remoteIp,
                  details: { rcptTo: rcptAddr },
                },
                db
              );
              writeLine(`550 5.7.1 <${rcptAddr}>: Relay access denied`);
              return;
            }
            const targets = findHostedRecipientAccounts(db, [rcptAddr]);
            if (targets.length === 0) {
              writeLine(`550 5.1.1 <${rcptAddr}>: Recipient address rejected: User unknown`);
              return;
            }
            const t = targets[0];
            if (t.status !== 'connected' || t.userStatus !== 'active') {
              writeLine(`550 5.2.1 <${rcptAddr}>: Mailbox suspended or disabled`);
              return;
            }
            if (t.usedBytes >= Math.max(1, t.quotaMb) * 1024 * 1024) {
              writeLine(`552 5.2.2 <${rcptAddr}>: Mailbox quota exceeded`);
              return;
            }
          }
          state.rcptTo.push(rcptAddr);
          writeLine('250 2.1.5 Ok');
          return;
        }
        case 'DATA': {
          if (state.mailFrom === null || state.rcptTo.length === 0) {
            writeLine('503 5.5.1 Need MAIL and RCPT commands first');
            return;
          }
          state.inData = true;
          state.dataLines = [];
          state.dataBytes = 0;
          writeLine('354 End data with <CR><LF>.<CR><LF>');
          return;
        }
        case 'RSET': {
          state.mailFrom = null;
          state.rcptTo = [];
          state.inData = false;
          state.dataLines = [];
          state.dataBytes = 0;
          writeLine('250 2.0.0 Ok');
          return;
        }
        case 'NOOP': {
          writeLine('250 2.0.0 Ok');
          return;
        }
        case 'QUIT': {
          writeLine(`221 2.0.0 ${hostname} closing connection`);
          activeSocket.end();
          return;
        }
        default:
          writeLine('502 5.5.2 Error: command not recognized');
      }
    };

    let queueChain = Promise.resolve();
    const wireDataStream = (sock: net.Socket) => {
      sock.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        while (true) {
          const idx = buffer.indexOf('\n');
          if (idx === -1) break;
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          queueChain = queueChain.then(() => processLine(line));
        }
      });
      sock.on('error', () => {
        // client reset
      });
    };

    wireDataStream(socket);
    writeLine(`220 ${hostname} ESMTP Cadence Mail Service`);
  };

  const activeSockets = new Set<net.Socket>();
  const tcpServer = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    attachSocketHandlers(socket, false);
  });

  const actualPort = await new Promise<number>((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(opts.port, opts.host, () => {
      const addr = tcpServer.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind SMTP socket'));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    server: tcpServer,
    mode: opts.mode,
    host: opts.host,
    port: actualPort,
    tlsEnabled: Boolean(tlsOpts),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of activeSockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        tcpServer.close(() => resolve());
      }),
  };
}

async function handleIncomingMxData(
  db: DatabaseSync,
  state: SmtpSessionState,
  rawMime: string,
  payloadSize: number,
  remoteIp: string,
  writeLine: (l: string) => void
): Promise<void> {
  const parsed = await simpleParser(rawMime);
  const fromList = parseAddressObj(parsed.from);
  const fromName = fromList[0]?.name || '';
  const fromAddress = (fromList[0]?.address || state.mailFrom || 'unknown@unknown.invalid').toLowerCase();
  const toList = parseAddressObj(parsed.to);
  const ccList = parseAddressObj(parsed.cc);
  const replyToList = parseAddressObj(parsed.replyTo);
  const subject = parsed.subject || '(no subject)';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = parsed.text || '';
  const messageIdHeader = parsed.messageId || `<in-${crypto.randomUUID()}@cadence.mx>`;
  const inReplyTo = typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : '';
  const referencesHeader = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : parsed.references || '';
  const authHeaderVal = String(parsed.headers.get('authentication-results') || '');

  const authEval = evaluateInboundAuthAndSpam(authHeaderVal, fromAddress, subject, html, text);
  const attachments = (parsed.attachments || []).map((a) => ({
    filename: a.filename || 'attachment',
    mimeType: a.contentType || 'application/octet-stream',
    content: a.content,
    contentId: a.contentId?.replace(/^<|>$/g, ''),
    isInline: a.contentDisposition === 'inline',
  }));

  const targets = findHostedRecipientAccounts(db, state.rcptTo);
  const now = new Date().toISOString();

  for (const target of targets) {
    const targetDomain = (target.emailAddress.split('@')[1] || 'cadence.local').toLowerCase();
    const res = ingestMessage(db, target.userId, target.accountId, {
      remoteId: `mx-${crypto.randomUUID()}`,
      messageIdHeader,
      inReplyTo,
      referencesHeader,
      folderRole: authEval.isSpam ? 'spam' : 'inbox',
      fromName,
      fromAddress,
      to: toList.length ? toList : [{ name: target.displayName, address: target.emailAddress }],
      cc: ccList,
      bcc: [],
      replyTo: replyToList,
      subject,
      rawHtml: html,
      rawText: text,
      sentAt: (parsed.date || new Date()).toISOString(),
      receivedAt: now,
      isRead: false,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: authEval.isSpam,
      isTrash: false,
      isArchived: false,
      authResults: { spf: authEval.spf, dkim: authEval.dkim, dmarc: authEval.dmarc },
      attachments,
    });

    if (res.inserted) {
      db.prepare("UPDATE messages SET delivery_status = 'received', delivery_detail = ? WHERE id = ?").run(
        `Received via SMTP MX from ${remoteIp}${authEval.spamReason ? ` (${authEval.spamReason})` : ''}`,
        res.messageId
      );
      recomputeAccountUsageBytes(db, target.accountId);
    }

    db.prepare(
      `INSERT INTO mail_delivery_logs (
        id, queue_id, direction, user_id, account_id, domain, from_address, to_addresses_json,
        message_id_header, status, remote_ip, mx_host, smtp_code, smtp_message, dkim_signed,
        spf_result, dkim_result, dmarc_result, size_bytes, created_at
      ) VALUES (?, NULL, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, '', 250, ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      target.userId,
      target.accountId,
      targetDomain,
      fromAddress,
      JSON.stringify([target.emailAddress]),
      messageIdHeader,
      authEval.isSpam ? 'rejected_spam' : 'received',
      remoteIp,
      authEval.isSpam ? `Quarantined as spam (${authEval.spamReason})` : 'Accepted into recipient Inbox',
      authEval.spf,
      authEval.dkim,
      authEval.dmarc,
      payloadSize,
      now
    );

    if (authEval.isSpam) {
      recordSecurityEvent(
        {
          userId: target.userId,
          eventType: 'spam_quarantined',
          severity: 'info',
          actorEmail: fromAddress,
          ipAddress: remoteIp,
          details: { subject, reason: authEval.spamReason },
        },
        db
      );
    }
  }

  writeLine(`250 2.0.0 Ok: queued for delivery (${targets.length} recipient(s))`);
}

async function handleSubmissionData(
  db: DatabaseSync,
  state: SmtpSessionState,
  rawMime: string,
  remoteIp: string,
  writeLine: (l: string) => void
): Promise<void> {
  if (!state.authUserId || !state.mailFrom) {
    writeLine('530 5.7.0 Authentication required');
    return;
  }

  const senderAccount = db
    .prepare(
      `SELECT a.id, a.user_id, a.email_address, a.display_name
       FROM accounts a
       WHERE a.user_id = ? AND a.provider_type IN ('hosted', 'local')
         AND (lower(a.email_address) = lower(?) OR EXISTS (SELECT 1 FROM mailbox_aliases al WHERE al.account_id = a.id AND lower(al.alias_address) = lower(?)))
       LIMIT 1`
    )
    .get(state.authUserId, state.mailFrom, state.mailFrom) as
    | { id: string; user_id: string; email_address: string; display_name: string }
    | undefined;

  if (!senderAccount) {
    writeLine('550 5.7.1 No matching hosted sender mailbox');
    return;
  }

  const parsed = await simpleParser(rawMime);
  const toList = parseAddressObj(parsed.to);
  const ccList = parseAddressObj(parsed.cc);
  const rcptParticipants: EmailParticipant[] =
    toList.length > 0 ? toList : state.rcptTo.map((addr) => ({ name: '', address: addr }));
  const subject = parsed.subject || '(no subject)';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = parsed.text || '';
  const messageIdHeader = parsed.messageId || `<sub-${crypto.randomUUID()}@${state.mailFrom.split('@')[1] || 'cadence.local'}>`;
  const attachments = (parsed.attachments || []).map((a) => ({
    filename: a.filename || 'attachment',
    mimeType: a.contentType || 'application/octet-stream',
    content: a.content,
    contentId: a.contentId?.replace(/^<|>$/g, ''),
    isInline: a.contentDisposition === 'inline',
  }));
  const now = new Date().toISOString();

  const sentIngest = ingestMessage(
    db,
    senderAccount.user_id,
    senderAccount.id,
    {
      remoteId: `smtp-sub-${crypto.randomUUID()}`,
      messageIdHeader,
      inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : '',
      referencesHeader: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '',
      folderRole: 'sent',
      fromName: senderAccount.display_name,
      fromAddress: state.mailFrom,
      to: rcptParticipants,
      cc: ccList,
      bcc: [],
      replyTo: [],
      subject,
      rawHtml: html || `<pre>${text}</pre>`,
      rawText: text,
      sentAt: now,
      receivedAt: now,
      isRead: true,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      attachments,
    },
    { skipNotifications: true, skipRules: true }
  );

  const bccExtras = state.rcptTo
    .filter((r) => !rcptParticipants.some((p) => p.address.toLowerCase() === r) && !ccList.some((p) => p.address.toLowerCase() === r))
    .map((addr) => ({ name: '', address: addr }));

  const queued = await enqueueHostedOutgoingMail(db, {
    userId: senderAccount.user_id,
    accountId: senderAccount.id,
    draftId: null,
    sentMessageId: sentIngest.messageId,
    messageIdHeader,
    fromName: senderAccount.display_name,
    fromAddress: state.mailFrom,
    to: rcptParticipants,
    cc: ccList,
    bcc: bccExtras,
    subject,
    html,
    text,
    attachments,
  });

  recomputeAccountUsageBytes(db, senderAccount.id);
  writeLine(`250 2.0.0 Ok: queued as ${queued.queueId || sentIngest.messageId} (from ${remoteIp})`);
}

let activeMxServer: SmtpServerHandle | null = null;
let activeSubmissionServer: SmtpServerHandle | null = null;
let smtpStartupWarnings: string[] = [];

export async function startPlatformSmtpServices(db: DatabaseSync = getDb()): Promise<void> {
  smtpStartupWarnings = [];
  if (!config.smtp.enabled) return;

  if (!activeMxServer) {
    try {
      activeMxServer = await startSmtpServer({
        mode: 'mx',
        host: config.smtp.bindHost,
        port: config.smtp.mxPort,
        db,
      });
    } catch (err: any) {
      smtpStartupWarnings.push(`MX listener (${config.smtp.bindHost}:${config.smtp.mxPort}): ${err?.message || err}`);
    }
  }

  if (!activeSubmissionServer) {
    try {
      activeSubmissionServer = await startSmtpServer({
        mode: 'submission',
        host: config.smtp.bindHost,
        port: config.smtp.submissionPort,
        db,
      });
    } catch (err: any) {
      smtpStartupWarnings.push(
        `Submission listener (${config.smtp.bindHost}:${config.smtp.submissionPort}): ${err?.message || err}`
      );
    }
  }
}

export async function stopPlatformSmtpServices(): Promise<void> {
  if (activeMxServer) {
    await activeMxServer.close();
    activeMxServer = null;
  }
  if (activeSubmissionServer) {
    await activeSubmissionServer.close();
    activeSubmissionServer = null;
  }
}

export function getSmtpServiceStatus() {
  return {
    enabled: config.smtp.enabled,
    publicHostname: config.smtp.publicHostname,
    outboundRelayConfigured: Boolean(config.smtp.relayHost),
    mx: activeMxServer
      ? { listening: true, host: activeMxServer.host, port: activeMxServer.port, tls: activeMxServer.tlsEnabled }
      : { listening: false, host: config.smtp.bindHost, port: config.smtp.mxPort, tls: false },
    submission: activeSubmissionServer
      ? {
          listening: true,
          host: activeSubmissionServer.host,
          port: activeSubmissionServer.port,
          tls: activeSubmissionServer.tlsEnabled,
        }
      : { listening: false, host: config.smtp.bindHost, port: config.smtp.submissionPort, tls: false },
    warnings: smtpStartupWarnings,
  };
}
