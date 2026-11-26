import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { config, QUEUE_DIR } from '../config.js';
import { getDb } from '../db/database.js';
import type { AttachmentInput } from '../providers/types.js';
import type { EmailParticipant } from '../types.js';
import { getDecryptedDkimForAddress } from './domainService.js';
import { eventBus } from './eventBus.js';
import { recordSecurityEvent } from './securityLogService.js';
import { ingestMessage } from './threadService.js';

export interface HostedRecipientMatch {
  accountId: string;
  userId: string;
  emailAddress: string;
  displayName: string;
  quotaMb: number;
  usedBytes: number;
  status: string;
  userStatus: string;
}

export function findHostedRecipientAccounts(db: DatabaseSync, addresses: string[]): HostedRecipientMatch[] {
  if (addresses.length === 0) return [];
  const normalized = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const seenAccountIds = new Set<string>();
  const results: HostedRecipientMatch[] = [];

  const directStmt = db.prepare(
    `SELECT a.id AS accountId, a.user_id AS userId, a.email_address AS emailAddress, a.display_name AS displayName,
            a.quota_mb AS quotaMb, a.used_bytes AS usedBytes, a.status, u.status AS userStatus
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.provider_type IN ('hosted', 'local') AND lower(a.email_address) = ?`
  );

  const aliasStmt = db.prepare(
    `SELECT a.id AS accountId, a.user_id AS userId, a.email_address AS emailAddress, a.display_name AS displayName,
            a.quota_mb AS quotaMb, a.used_bytes AS usedBytes, a.status, u.status AS userStatus
     FROM mailbox_aliases al
     JOIN accounts a ON a.id = al.account_id
     JOIN users u ON u.id = a.user_id
     WHERE a.provider_type IN ('hosted', 'local') AND lower(al.alias_address) = ?`
  );

  for (const addr of normalized) {
    const row = (directStmt.get(addr) || aliasStmt.get(addr)) as HostedRecipientMatch | undefined;
    if (row && !seenAccountIds.has(row.accountId)) {
      seenAccountIds.add(row.accountId);
      results.push(row);
    }
  }
  return results;
}

export function isDomainHostedHere(db: DatabaseSync, domainName: string): boolean {
  const dom = domainName.trim().toLowerCase();
  if (!dom) return false;
  const domainRow = db
    .prepare("SELECT id FROM domains WHERE lower(domain) = lower(?) AND status = 'active' LIMIT 1")
    .get(dom);
  if (domainRow) return true;
  const acctRow = db
    .prepare(
      "SELECT id FROM accounts WHERE provider_type IN ('hosted', 'local') AND status = 'connected' AND lower(email_address) LIKE ? LIMIT 1"
    )
    .get(`%@${dom}`);
  return Boolean(acctRow);
}

export function recomputeAccountUsageBytes(db: DatabaseSync, accountId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS totalBytes FROM messages WHERE account_id = ?')
    .get(accountId) as { totalBytes: number };
  db.prepare('UPDATE accounts SET used_bytes = ? WHERE id = ?').run(row.totalBytes || 0, accountId);
  return row.totalBytes || 0;
}

function recordDeliveryLog(
  db: DatabaseSync,
  entry: {
    queueId?: string | null;
    direction: 'outbound' | 'inbound';
    userId?: string | null;
    accountId?: string | null;
    domain: string;
    fromAddress: string;
    toAddresses: string[];
    messageIdHeader: string;
    status: string;
    remoteIp?: string;
    mxHost?: string;
    smtpCode?: number | null;
    smtpMessage?: string;
    dkimSigned?: boolean;
    spfResult?: string;
    dkimResult?: string;
    dmarcResult?: string;
    sizeBytes?: number;
  }
): void {
  db.prepare(
    `INSERT INTO mail_delivery_logs (
      id, queue_id, direction, user_id, account_id, domain, from_address, to_addresses_json,
      message_id_header, status, remote_ip, mx_host, smtp_code, smtp_message, dkim_signed,
      spf_result, dkim_result, dmarc_result, size_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    entry.queueId ?? null,
    entry.direction,
    entry.userId ?? null,
    entry.accountId ?? null,
    entry.domain,
    entry.fromAddress,
    JSON.stringify(entry.toAddresses),
    entry.messageIdHeader,
    entry.status,
    entry.remoteIp || '',
    entry.mxHost || '',
    entry.smtpCode ?? null,
    entry.smtpMessage || '',
    entry.dkimSigned ? 1 : 0,
    entry.spfResult || '',
    entry.dkimResult || '',
    entry.dmarcResult || '',
    entry.sizeBytes || 0,
    new Date().toISOString()
  );
}

function sendBounceNoticeToSender(
  db: DatabaseSync,
  params: {
    userId: string;
    accountId: string;
    fromAddress: string;
    failedRecipients: string[];
    subject: string;
    errorDetail: string;
    mxHost: string;
    messageIdHeader: string;
  }
): void {
  const domain = params.fromAddress.split('@')[1] || 'cadence.local';
  ingestMessage(db, params.userId, params.accountId, {
    remoteId: `bounce-${crypto.randomUUID()}`,
    messageIdHeader: `<dsn-${crypto.randomUUID()}@${domain}>`,
    inReplyTo: params.messageIdHeader,
    referencesHeader: params.messageIdHeader,
    folderRole: 'inbox',
    fromName: 'Mail Delivery Subsystem',
    fromAddress: `mailer-daemon@${domain}`,
    to: [{ name: '', address: params.fromAddress }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Delivery Status Notification (Failure): ${params.subject}`,
    rawHtml: `<p><strong>Delivery to the following recipient(s) failed permanently:</strong></p><ul>${params.failedRecipients
      .map((r) => `<li><code>${r}</code></li>`)
      .join('')}</ul><p><strong>Remote Host:</strong> ${params.mxHost || 'Direct MX'}<br><strong>Diagnostic Code:</strong> <code>${params.errorDetail}</code></p>`,
    rawText: `Delivery failed for: ${params.failedRecipients.join(', ')}\nHost: ${params.mxHost || 'Direct MX'}\nError: ${params.errorDetail}`,
    sentAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    isRead: false,
    isStarred: false,
    isImportant: true,
    isDraft: false,
    isSpam: false,
    isTrash: false,
    isArchived: false,
    attachments: [],
  });
}

async function compileSignedMimeBuffer(
  db: DatabaseSync,
  payload: {
    fromName: string;
    fromAddress: string;
    to: EmailParticipant[];
    cc: EmailParticipant[];
    bcc: EmailParticipant[];
    subject: string;
    html: string;
    text: string;
    messageIdHeader: string;
    inReplyTo?: string;
    referencesHeader?: string;
    attachments: AttachmentInput[];
  }
): Promise<{ rawBuffer: Buffer; dkimSigned: boolean }> {
  const dkim = getDecryptedDkimForAddress(db, payload.fromAddress);
  const streamTransporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'crlf',
    buffer: true,
    ...(dkim
      ? {
          dkim: {
            domainName: dkim.domainName,
            keySelector: dkim.keySelector,
            privateKey: dkim.privateKey,
          },
        }
      : {}),
  });

  const info = await streamTransporter.sendMail({
    from: payload.fromName ? `"${payload.fromName}" <${payload.fromAddress}>` : payload.fromAddress,
    to: payload.to.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
    cc: payload.cc.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
    subject: payload.subject,
    html: payload.html || undefined,
    text: payload.text || undefined,
    messageId: payload.messageIdHeader,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.referencesHeader || undefined,
    attachments: payload.attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: att.mimeType,
      cid: att.contentId,
      contentDisposition: att.isInline ? 'inline' : 'attachment',
    })),
  });

  return { rawBuffer: info.message as Buffer, dkimSigned: Boolean(dkim) };
}

export async function enqueueHostedOutgoingMail(
  db: DatabaseSync,
  params: {
    userId: string;
    accountId: string;
    draftId: string | null;
    sentMessageId: string;
    messageIdHeader: string;
    fromName: string;
    fromAddress: string;
    to: EmailParticipant[];
    cc: EmailParticipant[];
    bcc: EmailParticipant[];
    subject: string;
    html: string;
    text: string;
    inReplyTo?: string;
    referencesHeader?: string;
    attachments: AttachmentInput[];
    idempotencyKey?: string;
  }
): Promise<{ queueId: string | null; internalDelivered: number; externalQueued: number; overallStatus: string }> {
  const idempKey = params.idempotencyKey || (params.draftId ? `draft:${params.draftId}:${params.sentMessageId}` : '');
  if (idempKey) {
    const existingQueue = db
      .prepare('SELECT id, status FROM mail_queue WHERE user_id = ? AND idempotency_key = ? LIMIT 1')
      .get(params.userId, idempKey) as { id: string; status: string } | undefined;
    if (existingQueue) {
      return {
        queueId: existingQueue.id,
        internalDelivered: 0,
        externalQueued: 0,
        overallStatus: existingQueue.status,
      };
    }
  }
  const allRecipients = [...params.to, ...params.cc, ...params.bcc];
  const allAddrs = allRecipients.map((r) => r.address.trim().toLowerCase()).filter(Boolean);
  const hostedMatches = findHostedRecipientAccounts(db, allAddrs);
  const now = new Date().toISOString();
  const domain = (params.fromAddress.split('@')[1] || 'cadence.local').toLowerCase();

  // Map every address pointing to a local hosted account/alias so we don't also send via external MX
  const localAddressSet = new Set<string>();
  const msgSizeEst =
    Buffer.byteLength(params.html || params.text || '', 'utf8') +
    params.attachments.reduce((s, a) => s + a.content.byteLength, 0);

  let internalDelivered = 0;
  for (const target of hostedMatches) {
    localAddressSet.add(target.emailAddress.toLowerCase());
    const aliases = db
      .prepare('SELECT alias_address FROM mailbox_aliases WHERE account_id = ?')
      .all(target.accountId) as Array<{ alias_address: string }>;
    for (const al of aliases) localAddressSet.add(al.alias_address.toLowerCase());

    if (target.status !== 'connected' || target.userStatus !== 'active') {
      sendBounceNoticeToSender(db, {
        userId: params.userId,
        accountId: params.accountId,
        fromAddress: params.fromAddress,
        failedRecipients: [target.emailAddress],
        subject: params.subject,
        errorDetail: '550 5.2.1 Mailbox disabled or suspended',
        mxHost: 'internal-router',
        messageIdHeader: params.messageIdHeader,
      });
      continue;
    }

    const quotaLimitBytes = Math.max(1, target.quotaMb) * 1024 * 1024;
    if (target.usedBytes + msgSizeEst > quotaLimitBytes) {
      recordDeliveryLog(db, {
        direction: 'inbound',
        userId: target.userId,
        accountId: target.accountId,
        domain: target.emailAddress.split('@')[1] || domain,
        fromAddress: params.fromAddress,
        toAddresses: [target.emailAddress],
        messageIdHeader: params.messageIdHeader,
        status: 'rejected_quota',
        smtpCode: 552,
        smtpMessage: '5.2.2 Mailbox quota exceeded',
        sizeBytes: msgSizeEst,
      });
      sendBounceNoticeToSender(db, {
        userId: params.userId,
        accountId: params.accountId,
        fromAddress: params.fromAddress,
        failedRecipients: [target.emailAddress],
        subject: params.subject,
        errorDetail: '552 5.2.2 Recipient mailbox quota exceeded',
        mxHost: 'internal-router',
        messageIdHeader: params.messageIdHeader,
      });
      continue;
    }

    const deliveryMsgIdHeader =
      target.accountId === params.accountId ? `<recv-${crypto.randomUUID()}@${domain}>` : params.messageIdHeader;

    const ingested = ingestMessage(db, target.userId, target.accountId, {
      remoteId: `hosted-recv-${crypto.randomUUID()}`,
      messageIdHeader: deliveryMsgIdHeader,
      inReplyTo: params.inReplyTo || '',
      referencesHeader: params.referencesHeader || '',
      folderRole: 'inbox',
      fromName: params.fromName,
      fromAddress: params.fromAddress,
      to: params.to,
      cc: params.cc,
      bcc: [],
      replyTo: [],
      subject: params.subject || '(no subject)',
      rawHtml: params.html || `<pre>${params.text}</pre>`,
      rawText: params.text,
      sentAt: now,
      receivedAt: now,
      isRead: false,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isTrash: false,
      isArchived: false,
      attachments: params.attachments,
    });
    if (ingested.inserted) {
      db.prepare("UPDATE messages SET delivery_status = 'received', delivery_detail = 'Delivered internally on Cadence' WHERE id = ?").run(
        ingested.messageId
      );
      recomputeAccountUsageBytes(db, target.accountId);
      recordDeliveryLog(db, {
        direction: 'outbound',
        userId: params.userId,
        accountId: params.accountId,
        domain,
        fromAddress: params.fromAddress,
        toAddresses: [target.emailAddress],
        messageIdHeader: params.messageIdHeader,
        status: 'accepted_local',
        mxHost: 'internal-router',
        smtpCode: 250,
        smtpMessage: '2.0.0 Delivered internally to hosted mailbox',
        dkimSigned: false,
        sizeBytes: msgSizeEst,
      });
      internalDelivered += 1;
    }
  }

  // External recipients resolved outside our hosted database (or unknown recipients on external domains)
  const externalAddrs = [...new Set(allAddrs.filter((addr) => !localAddressSet.has(addr)))];
  if (externalAddrs.length === 0) {
    db.prepare("UPDATE messages SET delivery_status = 'accepted_local', delivery_detail = 'Delivered to hosted mailbox on this server' WHERE id = ?").run(
      params.sentMessageId
    );
    return {
      queueId: null,
      internalDelivered,
      externalQueued: 0,
      overallStatus: 'accepted_local',
    };
  }

  // Build real DKIM-signed RFC 2822 MIME message and persist to disk queue
  const queueId = crypto.randomUUID();
  const rawMimePath = path.join(QUEUE_DIR, `${queueId}.eml`);
  const { rawBuffer, dkimSigned } = await compileSignedMimeBuffer(db, params);
  fs.writeFileSync(rawMimePath, rawBuffer, { mode: 0o600 });

  const deliveryMode = config.smtp.relayHost ? 'smtp_relay' : 'hosted_mx';
  db.prepare(
    `INSERT INTO mail_queue (
      id, user_id, account_id, draft_id, message_id, from_address, recipients_json,
      subject, raw_mime_path, message_id_header, delivery_mode, status, idempotency_key, attempts,
      max_attempts, next_attempt_at, remote_mx_host, smtp_response, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, 5, ?, '', ?, ?, ?)`
  ).run(
    queueId,
    params.userId,
    params.accountId,
    params.draftId,
    params.sentMessageId,
    params.fromAddress,
    JSON.stringify(externalAddrs),
    params.subject,
    rawMimePath,
    params.messageIdHeader,
    deliveryMode,
    idempKey,
    now,
    dkimSigned ? 'DKIM-signed message queued for external MX delivery' : 'Queued for external MX delivery (unsigned)',
    now,
    now
  );

  db.prepare("UPDATE messages SET delivery_status = 'queued', delivery_detail = 'Queued in outbound MTA' WHERE id = ?").run(
    params.sentMessageId
  );

  // Trigger asynchronous non-blocking delivery pass immediately
  void processMailQueue(db).catch((err) => {
    console.error('[Cadence MTA queue] immediate sweep error:', err);
  });

  return {
    queueId,
    internalDelivered,
    externalQueued: externalAddrs.length,
    overallStatus: 'queued',
  };
}

async function deliverRawViaSmtp(params: {
  mxHost: string;
  port: number;
  secure: boolean;
  authUser?: string;
  authPass?: string;
  fromAddress: string;
  toAddresses: string[];
  rawBuffer: Buffer;
}): Promise<{ mxHost: string; response: string }> {
  const transporter = nodemailer.createTransport({
    host: params.mxHost,
    port: params.port,
    secure: params.secure,
    ignoreTLS: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 12_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
    ...(params.authUser && params.authPass
      ? { auth: { user: params.authUser, pass: params.authPass } }
      : {}),
  });

  const info = await transporter.sendMail({
    envelope: {
      from: params.fromAddress,
      to: params.toAddresses,
    },
    raw: params.rawBuffer,
  });

  return {
    mxHost: params.mxHost,
    response: info.response || '250 2.0.0 OK',
  };
}

async function resolveMxTargets(domain: string): Promise<string[]> {
  const overrideHost = process.env.CADENCE_MX_OVERRIDE_HOST?.trim();
  if (overrideHost) {
    return [overrideHost];
  }
  const resolver = new dns.promises.Resolver();
  try {
    const records = await resolver.resolveMx(domain);
    const sorted = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.replace(/\.$/, ''));
    if (sorted.length > 0) return sorted;
  } catch {
    // Fallback to A record of bare domain per RFC 5321 section 5.1 if no MX exists
  }
  try {
    const aRecs = await resolver.resolve4(domain);
    if (aRecs.length > 0) return [domain];
  } catch {
    // domain has neither MX nor A record
  }
  return [];
}

function isPermanentSmtpError(err: any): { permanent: boolean; code: number | null; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const responseCode = typeof err?.responseCode === 'number' ? err.responseCode : null;
  if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
    return { permanent: true, code: responseCode, message: msg };
  }
  if (/unrecognized|no mx or a record|mailbox unavailable|user unknown|relay/i.test(msg)) {
    return { permanent: true, code: responseCode ?? 550, message: msg };
  }
  return { permanent: false, code: responseCode, message: msg };
}

let queueSweepInFlight = false;

export async function processMailQueue(db: DatabaseSync = getDb()): Promise<void> {
  if (queueSweepInFlight) return;
  queueSweepInFlight = true;

  try {
    const nowIso = new Date().toISOString();
    const dueJobs = db
      .prepare("SELECT * FROM mail_queue WHERE status IN ('queued', 'retry_pending') AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 20")
      .all(nowIso) as Array<Record<string, any>>;

    for (const job of dueJobs) {
      const claim = db
        .prepare("UPDATE mail_queue SET status = 'processing', updated_at = ? WHERE id = ? AND status IN ('queued', 'retry_pending')")
        .run(nowIso, job.id);
      if (claim.changes === 0) continue;

      const recipients = JSON.parse(job.recipients_json || '[]') as string[];
      const attempts = Number(job.attempts || 0) + 1;
      const fromDomain = (String(job.from_address).split('@')[1] || 'cadence.local').toLowerCase();

      if (!job.raw_mime_path || !fs.existsSync(job.raw_mime_path)) {
        const failNow = new Date().toISOString();
        db.prepare("UPDATE mail_queue SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?").run(
          attempts,
          'Queued MIME payload file missing from disk',
          failNow,
          failNow,
          job.id
        );
        if (job.message_id) {
          db.prepare("UPDATE messages SET delivery_status = 'failed', delivery_detail = 'Queued payload missing on disk' WHERE id = ?").run(
            job.message_id
          );
        }
        continue;
      }

      const rawBuffer = fs.readFileSync(job.raw_mime_path);
      const dkimSigned = rawBuffer.includes(Buffer.from('DKIM-Signature:'));

      try {
        let acceptedMx = '';
        let lastResp = '';

        if (config.smtp.relayHost) {
          const res = await deliverRawViaSmtp({
            mxHost: config.smtp.relayHost,
            port: config.smtp.relayPort,
            secure: config.smtp.relaySecure,
            authUser: config.smtp.relayUser,
            authPass: config.smtp.relayPass,
            fromAddress: job.from_address,
            toAddresses: recipients,
            rawBuffer,
          });
          acceptedMx = res.mxHost;
          lastResp = res.response;
        } else {
          // Group external recipients by destination domain and connect directly to MX
          const byDomain = new Map<string, string[]>();
          for (const r of recipients) {
            const d = (r.split('@')[1] || '').toLowerCase();
            if (!d) continue;
            const list = byDomain.get(d) || [];
            list.push(r);
            byDomain.set(d, list);
          }

          const acceptedResponses: string[] = [];
          for (const [targetDomain, domRecipients] of byDomain) {
            // Check if local domain exists in our own domains table with no external MX override
            if (isDomainHostedHere(db, targetDomain)) {
              const noMailboxErr = new Error(`550 5.1.1 Unknown local recipient in hosted domain ${targetDomain}`);
              (noMailboxErr as any).responseCode = 550;
              throw noMailboxErr;
            }

            const mxTargets = await resolveMxTargets(targetDomain);
            if (mxTargets.length === 0) {
              const noMxErr = new Error(`No MX or A record resolved for external domain ${targetDomain}`);
              (noMxErr as any).responseCode = 550;
              throw noMxErr;
            }

            let domainDelivered = false;
            let domainLastErr: any = null;
            for (const mxHost of mxTargets.slice(0, 3)) {
              try {
                const res = await deliverRawViaSmtp({
                  mxHost,
                  port: config.smtp.outboundMxPort,
                  secure: false,
                  fromAddress: job.from_address,
                  toAddresses: domRecipients,
                  rawBuffer,
                });
                acceptedMx = res.mxHost;
                acceptedResponses.push(`${mxHost}: ${res.response}`);
                domainDelivered = true;
                break;
              } catch (err) {
                domainLastErr = err;
                const check = isPermanentSmtpError(err);
                if (check.permanent) throw err;
              }
            }
            if (!domainDelivered) {
              throw domainLastErr || new Error(`Failed delivering to MX servers for ${targetDomain}`);
            }
          }
          lastResp = acceptedResponses.join('; ');
        }

        const doneNow = new Date().toISOString();
        db.prepare(
          "UPDATE mail_queue SET status = 'accepted_by_mx', attempts = ?, remote_mx_host = ?, smtp_response = ?, last_error = NULL, updated_at = ?, completed_at = ? WHERE id = ?"
        ).run(attempts, acceptedMx, lastResp, doneNow, doneNow, job.id);

        if (job.message_id) {
          db.prepare("UPDATE messages SET delivery_status = 'accepted_by_mx', delivery_detail = ? WHERE id = ?").run(
            `Accepted by ${acceptedMx || 'MX'} (${lastResp})`,
            job.message_id
          );
        }

        recordDeliveryLog(db, {
          queueId: job.id,
          direction: 'outbound',
          userId: job.user_id,
          accountId: job.account_id,
          domain: fromDomain,
          fromAddress: job.from_address,
          toAddresses: recipients,
          messageIdHeader: job.message_id_header,
          status: 'accepted_by_mx',
          mxHost: acceptedMx,
          smtpCode: 250,
          smtpMessage: lastResp,
          dkimSigned,
          sizeBytes: rawBuffer.byteLength,
        });

        try {
          fs.unlinkSync(job.raw_mime_path);
        } catch {
          // ignore
        }

        eventBus.emit(job.user_id, 'thread_updated', { reason: 'delivery_accepted', queueId: job.id });
      } catch (err) {
        const info = isPermanentSmtpError(err);
        const failNow = new Date().toISOString();
        const maxAttempts = Number(job.max_attempts || 5);

        if (info.permanent || attempts >= maxAttempts) {
          const finalStatus = info.permanent ? 'bounced' : 'failed';
          db.prepare(
            "UPDATE mail_queue SET status = ?, attempts = ?, last_error = ?, smtp_response = ?, updated_at = ?, completed_at = ? WHERE id = ?"
          ).run(finalStatus, attempts, info.message, info.message, failNow, failNow, job.id);

          if (job.message_id) {
            db.prepare('UPDATE messages SET delivery_status = ?, delivery_detail = ? WHERE id = ?').run(
              finalStatus,
              info.message.slice(0, 300),
              job.message_id
            );
          }

          recordDeliveryLog(db, {
            queueId: job.id,
            direction: 'outbound',
            userId: job.user_id,
            accountId: job.account_id,
            domain: fromDomain,
            fromAddress: job.from_address,
            toAddresses: recipients,
            messageIdHeader: job.message_id_header,
            status: finalStatus,
            mxHost: job.remote_mx_host || '',
            smtpCode: info.code ?? 550,
            smtpMessage: info.message.slice(0, 400),
            dkimSigned,
            sizeBytes: rawBuffer.byteLength,
          });

          sendBounceNoticeToSender(db, {
            userId: job.user_id,
            accountId: job.account_id,
            fromAddress: job.from_address,
            failedRecipients: recipients,
            subject: job.subject || '(no subject)',
            errorDetail: info.message,
            mxHost: job.remote_mx_host || 'External MX',
            messageIdHeader: job.message_id_header,
          });

          try {
            fs.unlinkSync(job.raw_mime_path);
          } catch {
            // ignore
          }
          eventBus.emit(job.user_id, 'thread_updated', { reason: 'delivery_bounced', queueId: job.id });
        } else {
          // Transient error -> exponential backoff retry (30s, 2m, 10m, 30m)
          const delaySec = Math.min(1800, 30 * Math.pow(3, attempts - 1));
          const nextAttemptIso = new Date(Date.now() + delaySec * 1000).toISOString();
          db.prepare(
            "UPDATE mail_queue SET status = 'retry_pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?"
          ).run(attempts, nextAttemptIso, info.message, failNow, job.id);

          if (job.message_id) {
            db.prepare("UPDATE messages SET delivery_status = 'retry_pending', delivery_detail = ? WHERE id = ?").run(
              `Retry #${attempts} scheduled (${info.message.slice(0, 180)})`,
              job.message_id
            );
          }

          recordDeliveryLog(db, {
            queueId: job.id,
            direction: 'outbound',
            userId: job.user_id,
            accountId: job.account_id,
            domain: fromDomain,
            fromAddress: job.from_address,
            toAddresses: recipients,
            messageIdHeader: job.message_id_header,
            status: 'retry_pending',
            smtpCode: info.code ?? 421,
            smtpMessage: info.message.slice(0, 350),
            dkimSigned,
            sizeBytes: rawBuffer.byteLength,
          });

          recordSecurityEvent(
            {
              userId: job.user_id,
              eventType: 'outbound_retry_scheduled',
              severity: 'info',
              actorEmail: job.from_address,
              details: { queueId: job.id, attempts, error: info.message },
            },
            db
          );
        }
      }
    }
  } finally {
    queueSweepInFlight = false;
  }
}

export function retryMailQueueJobNow(db: DatabaseSync, queueId: string): boolean {
  const res = db
    .prepare(
      "UPDATE mail_queue SET status = 'retry_pending', next_attempt_at = ?, attempts = 0, updated_at = ? WHERE id = ? AND status IN ('queued', 'retry_pending', 'failed', 'bounced', 'dead_letter') AND raw_mime_path != ''"
    )
    .run(new Date().toISOString(), new Date().toISOString(), queueId);
  return res.changes > 0;
}

export function moveQueueJobToDeadLetter(db: DatabaseSync, queueId: string, reason = 'Moved to dead-letter queue by administrator'): boolean {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      "UPDATE mail_queue SET status = 'dead_letter', last_error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'delivering', 'retry_pending', 'failed', 'bounced')"
    )
    .run(reason, now, now, queueId);
  return res.changes > 0;
}
