import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import type { EmailParticipant, ProviderCapabilities, SystemFolderRole } from '../types.js';
import type {
  AttachmentInput,
  EmailProviderAdapter,
  ImapSmtpCredentials,
  ProviderCredentials,
  RemoteFolder,
  RemoteLabel,
  RemoteMessagePayload,
  SendMessagePayload,
  SendMessageResult,
  SyncResult,
} from './types.js';

export const IMAP_SMTP_CAPABILITIES: ProviderCapabilities = {
  accountOwnership: 'external',
  supportsSend: true,
  supportsReceive: true,
  supportsSearch: true,
  supportsLabels: false,
  supportsFolders: true,
  supportsThreads: true,
  supportsDraftSync: false,
  supportsAttachments: true,
  supportsArchive: true,
  supportsDelete: true,
  supportsSpam: true,
  supportsReadState: true,
  supportsStarredState: true,
  supportsImportance: false,
  supportsIdle: true,
  supportsOAuth: false,
  supportsRemoteSearch: true,
  supportsPhishingReport: false,
  supportsScheduledSendNative: false,
  supportsRulesSync: false,
  supportsContactsSync: false,
  supportsAliases: false,
  supportsDkim: false,
  capabilityNotes: {
    labels: 'Standard IMAP stores folders rather than arbitrary tags; labels applied in Cadence remain local.',
    draftSync: 'Drafts are persisted securely on Cadence rather than pushed via IMAP APPEND.',
    scheduledSendNative: 'Scheduled emails are dispatched reliably by the Cadence background scheduler.',
  },
};

export const YAHOO_CAPABILITIES: ProviderCapabilities = {
  ...IMAP_SMTP_CAPABILITIES,
  capabilityNotes: {
    labels: 'Yahoo Mail organizes messages via folders; labels applied in Cadence are stored locally.',
    oauth: 'Connects via Yahoo Mail IMAP/SMTP with an App Password.',
  },
};

function createImapClient(creds: ImapSmtpCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.imapHost.trim(),
    port: creds.imapPort,
    secure: creds.imapPort === 993 ? true : creds.imapPort === 143 ? false : creds.imapSecure,
    connectionTimeout: 15_000,
    greetingTimeout: 12_000,
    socketTimeout: 30_000,
    auth: {
      user: creds.username.trim(),
      pass: creds.password,
    },
    logger: false,
  });
}

function createSmtpTransporter(creds: ImapSmtpCredentials) {
  const useImplicitTls =
    creds.smtpPort === 465 ? true : creds.smtpPort === 587 || creds.smtpPort === 25 ? false : creds.smtpSecure;
  return nodemailer.createTransport({
    host: creds.smtpHost.trim(),
    port: creds.smtpPort,
    secure: useImplicitTls,
    requireTLS: !useImplicitTls && creds.smtpPort === 587,
    connectionTimeout: 15_000,
    greetingTimeout: 12_000,
    socketTimeout: 30_000,
    auth: {
      user: creds.username.trim(),
      pass: creds.password,
    },
  });
}

function formatImapSmtpError(err: unknown, context: 'imap' | 'smtp'): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes('authenticationfailed') || lower.includes('invalid credentials') || lower.includes('username and password not accepted') || lower.includes('535')) {
    return `${context.toUpperCase()} authentication failed (${raw}). If using Gmail, Yahoo, or iCloud with 2FA enabled, generate an App Password instead of using your regular login password.`;
  }
  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return `Could not reach ${context.toUpperCase()} server host (${raw}). Verify hostname and internet connection.`;
  }
  if (lower.includes('etimedout') || lower.includes('econnrefused')) {
    return `Connection to ${context.toUpperCase()} server timed out or was refused (${raw}). Check host and port (IMAP 993 / SMTP 465 or 587).`;
  }
  return raw;
}

function normalizeAddresses(addrObj?: AddressObject | AddressObject[]): EmailParticipant[] {
  if (!addrObj) return [];
  const arr = Array.isArray(addrObj) ? addrObj : [addrObj];
  const out: EmailParticipant[] = [];
  for (const item of arr) {
    for (const val of item.value || []) {
      if (val.address) {
        out.push({
          name: val.name || '',
          address: val.address,
        });
      }
    }
  }
  return out;
}

function inferSystemRole(pathName: string, specialUse?: string): SystemFolderRole {
  const su = (specialUse || '').toLowerCase();
  const lower = pathName.toLowerCase();
  if (su === '\\inbox' || lower === 'inbox') return 'inbox';
  if (su === '\\sent' || lower.includes('sent')) return 'sent';
  if (su === '\\drafts' || lower.includes('draft')) return 'drafts';
  if (su === '\\trash' || lower.includes('trash') || lower.includes('deleted')) return 'trash';
  if (su === '\\junk' || lower.includes('spam') || lower.includes('junk')) return 'spam';
  if (su === '\\archive' || lower.includes('archive')) return 'archive';
  return 'custom';
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('authenticationfailed') ||
    msg.includes('invalid credentials') ||
    msg.includes('auth') ||
    msg.includes('login failed')
  );
}

function isImapCreds(creds: ProviderCredentials): creds is ImapSmtpCredentials {
  return creds.type === 'imap_smtp' || creds.type === 'yahoo';
}

export class ImapSmtpAdapter implements EmailProviderAdapter {
  readonly providerType = 'imap_smtp' as const;
  readonly capabilities = IMAP_SMTP_CAPABILITIES;

  async testConnection(credentials: ProviderCredentials): Promise<{ ok: boolean; error?: string }> {
    if (!isImapCreds(credentials)) {
      return { ok: false, error: 'Invalid credential type for IMAP/SMTP adapter' };
    }
    const client = createImapClient(credentials);
    try {
      await client.connect();
      await client.logout();
    } catch (err) {
      return { ok: false, error: formatImapSmtpError(err, 'imap') };
    } finally {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    }

    try {
      const smtp = createSmtpTransporter(credentials);
      await smtp.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatImapSmtpError(err, 'smtp') };
    }
  }

  async fetchFolders(credentials: ProviderCredentials): Promise<RemoteFolder[]> {
    if (!isImapCreds(credentials)) return [];
    const client = createImapClient(credentials);
    try {
      await client.connect();
      const list = await client.list();
      return list.map((box) => ({
        remoteId: box.path,
        name: box.name,
        slug: box.path.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        systemRole: inferSystemRole(box.path, box.specialUse),
      }));
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  async fetchLabels(_credentials: ProviderCredentials): Promise<RemoteLabel[]> {
    return [];
  }

  async syncChanges(credentials: ProviderCredentials, cursor: string): Promise<SyncResult> {
    if (!isImapCreds(credentials)) {
      return { added: [], updated: [], nextCursor: cursor, error: 'Invalid credentials' };
    }

    let folderCursors: Record<string, { uidValidity?: string; lastUid?: number }> = {};
    if (cursor) {
      try {
        const parsedCursor = JSON.parse(cursor) as {
          folders?: Record<string, { uidValidity?: string; lastUid?: number }>;
          uidValidity?: string;
          lastUid?: number;
        };
        if (parsedCursor.folders) {
          folderCursors = parsedCursor.folders;
        } else if (parsedCursor.uidValidity || parsedCursor.lastUid) {
          folderCursors = { INBOX: { uidValidity: parsedCursor.uidValidity, lastUid: parsedCursor.lastUid } };
        }
      } catch {
        folderCursors = {};
      }
    }

    const client = createImapClient(credentials);
    const added: RemoteMessagePayload[] = [];

    try {
      await client.connect();
      const mailboxes = await client.list();
      const targetBoxes = mailboxes.filter((box) => {
        if (box.flags?.has('\\Noselect')) return false;
        const su = (box.specialUse || '').toLowerCase();
        if (su === '\\all' || su === '\\important' || su === '\\flagged') return false;
        const role = inferSystemRole(box.path, box.specialUse);
        return ['inbox', 'sent', 'archive', 'trash', 'spam', 'drafts'].includes(role);
      });
      if (targetBoxes.length === 0) {
        targetBoxes.push({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' } as any);
      }

      for (const box of targetBoxes.slice(0, 6)) {
        const role = inferSystemRole(box.path, box.specialUse);
        const state = folderCursors[box.path] || {};
        let maxUid = state.lastUid || 0;
        let uidValidity = state.uidValidity || '';

        try {
          const lock = await client.getMailboxLock(box.path);
          try {
            const mailbox = client.mailbox;
            const currentUidValidity = mailbox && typeof mailbox !== 'boolean' ? String(mailbox.uidValidity) : '';
            if (uidValidity && currentUidValidity && uidValidity !== currentUidValidity) {
              maxUid = 0;
            }
            uidValidity = currentUidValidity;

            const total = mailbox && typeof mailbox !== 'boolean' ? mailbox.exists : 0;
            if (total > 0) {
              const searchCriteria = maxUid > 0 ? { uid: `${maxUid + 1}:*` } : { all: true };
              const uids = await client.search(searchCriteria, { uid: true });
              const targetUids = Array.isArray(uids)
                ? uids.filter((u) => u > maxUid).sort((a, b) => a - b).slice(-30)
                : [];

            for (const uid of targetUids) {
              const msg = await client.fetchOne(
                String(uid),
                { source: true, flags: true, uid: true, threadId: true },
                { uid: true }
              );
              if (!msg || !msg.source) continue;
              const parsed = await simpleParser(msg.source);
              const fromList = normalizeAddresses(parsed.from);
              const toList = normalizeAddresses(parsed.to);
              const ccList = normalizeAddresses(parsed.cc);
              const bccList = normalizeAddresses(parsed.bcc);
              const replyToList = normalizeAddresses(parsed.replyTo);
              const flags = msg.flags || new Set<string>();
              const attachments: AttachmentInput[] = (parsed.attachments || []).map((att) => ({
                filename: att.filename || 'attachment',
                mimeType: att.contentType || 'application/octet-stream',
                content: att.content,
                contentId: att.cid || undefined,
                isInline: att.contentDisposition === 'inline',
              }));

              const refs = Array.isArray(parsed.references)
                ? parsed.references.join(' ')
                : parsed.references || '';

              const sentAt = (parsed.date || new Date()).toISOString();
              added.push({
                remoteId: `${box.path}:${uid}`,
                remoteThreadId: msg.threadId || undefined,
                messageIdHeader: parsed.messageId || `<imap-${box.path}-${uid}@${credentials.imapHost}>`,
                inReplyTo: parsed.inReplyTo || '',
                referencesHeader: refs,
                folderRole: role,
                folderRemoteId: box.path,
                fromName: fromList[0]?.name || '',
                fromAddress: fromList[0]?.address || credentials.username,
                to: toList,
                cc: ccList,
                bcc: bccList,
                replyTo: replyToList,
                subject: parsed.subject || '(no subject)',
                rawHtml: typeof parsed.html === 'string' ? parsed.html : '',
                rawText: parsed.text || '',
                sentAt,
                receivedAt: sentAt,
                isRead: flags.has('\\Seen') || role === 'sent',
                isStarred: flags.has('\\Flagged'),
                isImportant: false,
                isDraft: flags.has('\\Draft') || role === 'drafts',
                isSpam: role === 'spam',
                isTrash: flags.has('\\Deleted') || role === 'trash',
                isArchived: role === 'archive',
                attachments,
              });
              if (uid > maxUid) maxUid = uid;
            }
          }
          } finally {
            lock.release();
          }

          folderCursors[box.path] = { uidValidity, lastUid: maxUid };
        } catch (boxErr) {
          if (role === 'inbox' || box.path.toUpperCase() === 'INBOX') {
            throw boxErr;
          }
        }
      }

      return {
        added,
        updated: [],
        nextCursor: JSON.stringify({ folders: folderCursors }),
      };
    } catch (err) {
      return {
        added: [],
        updated: [],
        nextCursor: cursor,
        expiredAuth: isAuthError(err),
        error: err instanceof Error ? err.message : 'IMAP synchronization failed',
      };
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  async sendMessage(credentials: ProviderCredentials, payload: SendMessagePayload): Promise<SendMessageResult> {
    if (!isImapCreds(credentials)) {
      throw new Error('Invalid credential type for SMTP send');
    }
    const transporter = createSmtpTransporter(credentials);
    const info = await transporter.sendMail({
      from: payload.fromName ? `"${payload.fromName}" <${payload.fromAddress}>` : payload.fromAddress,
      to: payload.to.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
      cc: payload.cc.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
      bcc: payload.bcc.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
      subject: payload.subject,
      html: payload.html || undefined,
      text: payload.text || undefined,
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
    return {
      remoteId: info.messageId,
      messageIdHeader: info.messageId,
    };
  }

  private groupRemoteIdsByFolder(remoteIds: string[]): Map<string, number[]> {
    const grouped = new Map<string, number[]>();
    for (const rid of remoteIds) {
      const idx = rid.lastIndexOf(':');
      const folderPath = idx > 0 ? rid.slice(0, idx) : 'INBOX';
      const uid = Number(idx > 0 ? rid.slice(idx + 1) : rid);
      if (!Number.isFinite(uid) || uid <= 0) continue;
      const list = grouped.get(folderPath) || [];
      list.push(uid);
      grouped.set(folderPath, list);
    }
    return grouped;
  }

  async markRead(credentials: ProviderCredentials, remoteIds: string[], isRead: boolean): Promise<void> {
    if (!isImapCreds(credentials) || remoteIds.length === 0) return;
    const grouped = this.groupRemoteIdsByFolder(remoteIds);
    if (grouped.size === 0) return;
    const client = createImapClient(credentials);
    try {
      await client.connect();
      for (const [folderPath, uids] of grouped) {
        const lock = await client.getMailboxLock(folderPath);
        try {
          if (isRead) {
            await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
          } else {
            await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  async setStarred(credentials: ProviderCredentials, remoteIds: string[], isStarred: boolean): Promise<void> {
    if (!isImapCreds(credentials) || remoteIds.length === 0) return;
    const grouped = this.groupRemoteIdsByFolder(remoteIds);
    if (grouped.size === 0) return;
    const client = createImapClient(credentials);
    try {
      await client.connect();
      for (const [folderPath, uids] of grouped) {
        const lock = await client.getMailboxLock(folderPath);
        try {
          if (isStarred) {
            await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
          } else {
            await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  async moveToFolder(credentials: ProviderCredentials, remoteIds: string[], targetFolderRemoteId: string): Promise<void> {
    if (!isImapCreds(credentials) || remoteIds.length === 0) return;
    const grouped = this.groupRemoteIdsByFolder(remoteIds);
    if (grouped.size === 0) return;
    const client = createImapClient(credentials);
    try {
      await client.connect();
      const boxes = await client.list();
      const targetRole = targetFolderRemoteId.toLowerCase();
      const matched =
        boxes.find((b) => b.path === targetFolderRemoteId) ||
        boxes.find((b) => inferSystemRole(b.path, b.specialUse) === targetRole);
      const destination = matched?.path || targetFolderRemoteId;

      for (const [folderPath, uids] of grouped) {
        if (folderPath === destination) continue;
        const lock = await client.getMailboxLock(folderPath);
        try {
          if (matched) {
            await client.messageMove(uids, destination, { uid: true });
          } else if (targetRole === 'trash') {
            await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  async searchRemote(credentials: ProviderCredentials, query: string): Promise<RemoteMessagePayload[]> {
    if (!isImapCreds(credentials) || !query.trim()) return [];
    const q = query.trim();
    const client = createImapClient(credentials);
    const results: RemoteMessagePayload[] = [];
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ or: [{ subject: q }, { from: q }, { body: q }] }, { uid: true });
        if (uids && uids.length > 0) {
          const tailUids = [...uids].sort((a, b) => a - b).slice(-15);
          for await (const msg of client.fetch(tailUids, { uid: true, flags: true, source: true }, { uid: true })) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const fromList = normalizeAddresses(parsed.from);
            const rawHtml = typeof parsed.html === 'string' ? parsed.html : '';
            const rawText = parsed.text || '';
            const uid = msg.uid || msg.seq;
            results.push({
              remoteId: `INBOX:${uid}`,
              messageIdHeader: parsed.messageId || `<imap-search-${uid}@${credentials.imapHost}>`,
              inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : '',
              referencesHeader: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '',
              folderRole: 'inbox',
              fromName: fromList[0]?.name || '',
              fromAddress: fromList[0]?.address || credentials.username,
              to: normalizeAddresses(parsed.to),
              cc: normalizeAddresses(parsed.cc),
              bcc: normalizeAddresses(parsed.bcc),
              replyTo: normalizeAddresses(parsed.replyTo),
              subject: parsed.subject || '(no subject)',
              rawHtml,
              rawText,
              sentAt: (parsed.date || new Date()).toISOString(),
              receivedAt: (parsed.date || new Date()).toISOString(),
              isRead: msg.flags?.has('\\Seen') || false,
              isStarred: msg.flags?.has('\\Flagged') || false,
              isImportant: false,
              isDraft: msg.flags?.has('\\Draft') || false,
              isSpam: false,
              isTrash: false,
              isArchived: false,
              attachments: (parsed.attachments || []).slice(0, 6).map((a) => ({
                filename: a.filename || 'attachment',
                mimeType: a.contentType || 'application/octet-stream',
                content: a.content,
                contentId: a.contentId?.replace(/^<|>$/g, ''),
                isInline: a.contentDisposition === 'inline',
              })),
            });
          }
        }
      } finally {
        lock.release();
      }
      return results;
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }
}
