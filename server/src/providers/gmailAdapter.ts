import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { EmailParticipant, ProviderCapabilities } from '../types.js';
import type {
  EmailProviderAdapter,
  OAuthCredentials,
  ProviderCredentials,
  RemoteContactEntry,
  RemoteFolder,
  RemoteLabel,
  RemoteMessagePayload,
  SendMessagePayload,
  SendMessageResult,
  SyncResult,
} from './types.js';

export const GMAIL_CAPABILITIES: ProviderCapabilities = {
  accountOwnership: 'external',
  supportsSend: true,
  supportsReceive: true,
  supportsSearch: true,
  supportsLabels: true,
  supportsFolders: false,
  supportsThreads: true,
  supportsDraftSync: true,
  supportsAttachments: true,
  supportsArchive: true,
  supportsDelete: true,
  supportsSpam: true,
  supportsReadState: true,
  supportsStarredState: true,
  supportsImportance: true,
  supportsIdle: false,
  supportsOAuth: true,
  supportsRemoteSearch: true,
  supportsPhishingReport: true,
  supportsScheduledSendNative: false,
  supportsRulesSync: false,
  supportsContactsSync: true,
  supportsAliases: false,
  supportsDkim: false,
  capabilityNotes: {
    folders: 'Gmail uses mutually compatible labels rather than nested IMAP folders; custom folders remain local.',
    scheduledSendNative: 'Scheduled sending is managed by the Cadence background queue.',
  },
};

export function isGmailOAuthConfigured(): boolean {
  return Boolean(config.oauth.google.clientId && config.oauth.google.clientSecret);
}

export function buildGmailAuthUrl(state: string, codeChallenge: string, includeCalendar = false): string {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];
  if (includeCalendar) {
    scopes.push('https://www.googleapis.com/auth/calendar.readonly');
  }
  const params = new URLSearchParams({
    client_id: config.oauth.google.clientId,
    redirect_uri: config.oauth.google.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGmailCode(code: string, codeVerifier: string): Promise<OAuthCredentials> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.oauth.google.clientId,
      client_secret: config.oauth.google.clientSecret,
      redirect_uri: config.oauth.google.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth token exchange failed: ${await res.text()}`);
  }
  const tokenData = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error('Failed to retrieve Gmail user profile');
  }
  const profile = (await profileRes.json()) as { emailAddress: string };
  return {
    type: 'gmail',
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || '',
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    scope: tokenData.scope,
    email: profile.emailAddress,
  };
}

async function ensureFreshToken(creds: OAuthCredentials): Promise<{ creds: OAuthCredentials; refreshed: boolean }> {
  if (creds.expiresAt > Date.now() + 60_000) return { creds, refreshed: false };
  if (!creds.refreshToken || !isGmailOAuthConfigured()) {
    throw new Error('AUTH_EXPIRED');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.oauth.google.clientId,
      client_secret: config.oauth.google.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error('AUTH_EXPIRED');
  }
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  return {
    refreshed: true,
    creds: {
      ...creds,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    },
  };
}

function parseAddressList(raw: string): EmailParticipant[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(?:"?([^"]*)"?\s+)?<([^>]+)>$/);
      if (m) return { name: (m[1] || '').trim(), address: m[2].trim() };
      return { name: '', address: entry };
    });
}

function decodeBase64Url(input?: string): string {
  if (!input) return '';
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
}

function extractGmailBodies(payload?: GmailPart): { html: string; text: string } {
  let html = '';
  let text = '';
  if (!payload) return { html, text };

  const walk = (part: GmailPart) => {
    if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/plain' && part.body?.data && !text) {
      text = decodeBase64Url(part.body.data);
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  };
  walk(payload);
  return { html, text };
}

interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId?: string;
  inlineData?: string;
  size: number;
  contentId?: string;
  isInline: boolean;
}

function extractGmailAttachmentRefs(payload?: GmailPart): GmailAttachmentRef[] {
  const refs: GmailAttachmentRef[] = [];
  if (!payload) return refs;

  const walk = (part: GmailPart) => {
    if (part.filename && (part.body?.attachmentId || part.body?.data)) {
      const hdrMap: Record<string, string> = {};
      for (const h of part.headers || []) hdrMap[h.name.toLowerCase()] = h.value;
      const cidRaw = hdrMap['content-id'] || '';
      const contentId = cidRaw.replace(/^<|>$/g, '');
      const disposition = hdrMap['content-disposition'] || '';
      refs.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        attachmentId: part.body.attachmentId,
        inlineData: part.body.data,
        size: part.body.size || 0,
        contentId: contentId || undefined,
        isInline: disposition.toLowerCase().includes('inline') && Boolean(contentId),
      });
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  };
  walk(payload);
  return refs;
}

export class GmailAdapter implements EmailProviderAdapter {
  readonly providerType = 'gmail' as const;
  readonly capabilities = GMAIL_CAPABILITIES;

  async testConnection(credentials: ProviderCredentials): Promise<{ ok: boolean; error?: string }> {
    if (credentials.type !== 'gmail') return { ok: false, error: 'Invalid credentials for Gmail' };
    try {
      const { creds: fresh } = await ensureFreshToken(credentials);
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${fresh.accessToken}` },
      });
      if (!res.ok) return { ok: false, error: `Gmail API returned ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Gmail connection check failed' };
    }
  }

  async fetchFolders(_credentials: ProviderCredentials): Promise<RemoteFolder[]> {
    return [
      { remoteId: 'INBOX', name: 'Inbox', slug: 'inbox', systemRole: 'inbox' },
      { remoteId: 'SENT', name: 'Sent', slug: 'sent', systemRole: 'sent' },
      { remoteId: 'DRAFT', name: 'Drafts', slug: 'drafts', systemRole: 'drafts' },
      { remoteId: 'SPAM', name: 'Spam', slug: 'spam', systemRole: 'spam' },
      { remoteId: 'TRASH', name: 'Trash', slug: 'trash', systemRole: 'trash' },
    ];
  }

  async fetchLabels(credentials: ProviderCredentials): Promise<RemoteLabel[]> {
    if (credentials.type !== 'gmail') return [];
    const { creds: fresh } = await ensureFreshToken(credentials);
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      labels?: Array<{ id: string; name: string; type: string; color?: { backgroundColor?: string } }>;
    };
    return (data.labels || [])
      .filter((l) => l.type === 'user')
      .map((l) => ({ remoteId: l.id, name: l.name, color: l.color?.backgroundColor }));
  }

  private async fetchSingleMessage(
    messageId: string,
    headers: Record<string, string>,
    accountEmail: string
  ): Promise<RemoteMessagePayload | null> {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      { headers }
    );
    if (!msgRes.ok) return null;
    const msgData = (await msgRes.json()) as {
      id: string;
      threadId: string;
      labelIds?: string[];
      internalDate?: string;
      payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
    };
    const hdrMap: Record<string, string> = {};
    for (const h of msgData.payload?.headers || []) {
      hdrMap[h.name.toLowerCase()] = h.value;
    }
    const labels = msgData.labelIds || [];
    const fromParsed = parseAddressList(hdrMap['from'] || '');
    const bodies = extractGmailBodies(msgData.payload);
    const sentIso = msgData.internalDate ? new Date(Number(msgData.internalDate)).toISOString() : new Date().toISOString();

    const attRefs = extractGmailAttachmentRefs(msgData.payload);
    const attachments = [];
    for (const ref of attRefs.slice(0, 8)) {
      if (ref.size > 5 * 1024 * 1024) continue;
      if (ref.inlineData) {
        attachments.push({
          filename: ref.filename,
          mimeType: ref.mimeType,
          content: Buffer.from(ref.inlineData.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
          contentId: ref.contentId,
          isInline: ref.isInline,
        });
      } else if (ref.attachmentId) {
        const attRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgData.id)}/attachments/${encodeURIComponent(ref.attachmentId)}`,
          { headers }
        );
        if (attRes.ok) {
          const attData = (await attRes.json()) as { data?: string };
          if (attData.data) {
            attachments.push({
              filename: ref.filename,
              mimeType: ref.mimeType,
              content: Buffer.from(attData.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
              contentId: ref.contentId,
              isInline: ref.isInline,
            });
          }
        }
      }
    }

    return {
      remoteId: msgData.id,
      remoteThreadId: msgData.threadId,
      messageIdHeader: hdrMap['message-id'] || `<${msgData.id}@gmail.com>`,
      inReplyTo: hdrMap['in-reply-to'] || '',
      referencesHeader: hdrMap['references'] || '',
      folderRole: labels.includes('TRASH')
        ? 'trash'
        : labels.includes('SPAM')
        ? 'spam'
        : labels.includes('SENT')
        ? 'sent'
        : labels.includes('INBOX')
        ? 'inbox'
        : 'archive',
      fromName: fromParsed[0]?.name || '',
      fromAddress: fromParsed[0]?.address || accountEmail,
      to: parseAddressList(hdrMap['to'] || ''),
      cc: parseAddressList(hdrMap['cc'] || ''),
      bcc: parseAddressList(hdrMap['bcc'] || ''),
      replyTo: parseAddressList(hdrMap['reply-to'] || ''),
      subject: hdrMap['subject'] || '(no subject)',
      rawHtml: bodies.html,
      rawText: bodies.text,
      sentAt: sentIso,
      receivedAt: sentIso,
      isRead: !labels.includes('UNREAD'),
      isStarred: labels.includes('STARRED'),
      isImportant: labels.includes('IMPORTANT'),
      isDraft: labels.includes('DRAFT'),
      isSpam: labels.includes('SPAM'),
      isTrash: labels.includes('TRASH'),
      isArchived: !labels.includes('INBOX') && !labels.includes('TRASH') && !labels.includes('SPAM'),
      attachments,
    };
  }

  async syncChanges(credentials: ProviderCredentials, cursor: string): Promise<SyncResult> {
    if (credentials.type !== 'gmail') {
      return { added: [], updated: [], nextCursor: cursor, error: 'Invalid credential type' };
    }
    try {
      const { creds: fresh, refreshed } = await ensureFreshToken(credentials);
      const headers = { Authorization: `Bearer ${fresh.accessToken}` };
      const added: RemoteMessagePayload[] = [];
      const updated: SyncResult['updated'] = [];

      // Attempt incremental historyId sync if cursor looks like a Gmail historyId
      if (cursor && /^\d+$/.test(cursor)) {
        const histRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(cursor)}&historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved`,
          { headers }
        );
        if (histRes.status === 401) {
          return { added: [], updated: [], nextCursor: cursor, expiredAuth: true, error: 'Gmail authorization expired' };
        }
        if (histRes.ok) {
          const histData = (await histRes.json()) as {
            historyId?: string;
            history?: Array<{
              messagesAdded?: Array<{ message: { id: string } }>;
              labelsAdded?: Array<{ message: { id: string; labelIds?: string[] } }>;
              labelsRemoved?: Array<{ message: { id: string; labelIds?: string[] } }>;
            }>;
          };
          const addedIds = new Set<string>();
          const changedMsgs = new Map<string, string[]>();
          for (const entry of histData.history || []) {
            for (const m of entry.messagesAdded || []) addedIds.add(m.message.id);
            for (const l of entry.labelsAdded || []) {
              if (l.message.labelIds) changedMsgs.set(l.message.id, l.message.labelIds);
            }
            for (const l of entry.labelsRemoved || []) {
              if (l.message.labelIds) changedMsgs.set(l.message.id, l.message.labelIds);
            }
          }
          for (const id of Array.from(addedIds).slice(0, 50)) {
            const payload = await this.fetchSingleMessage(id, headers, fresh.email);
            if (payload) added.push(payload);
          }
          for (const [id, lbls] of changedMsgs) {
            if (addedIds.has(id)) continue;
            updated.push({
              remoteId: id,
              isRead: !lbls.includes('UNREAD'),
              isStarred: lbls.includes('STARRED'),
              isImportant: lbls.includes('IMPORTANT'),
              isSpam: lbls.includes('SPAM'),
              isTrash: lbls.includes('TRASH'),
              isArchived: !lbls.includes('INBOX') && !lbls.includes('TRASH') && !lbls.includes('SPAM'),
            });
          }
          return {
            added,
            updated,
            nextCursor: histData.historyId || cursor,
            refreshedCredentials: refreshed ? fresh : undefined,
          };
        }
        // HTTP 404 from history API means startHistoryId expired -> fall through to recent full resync
      }

      const listIds: Array<{ id: string; threadId: string }> = [];
      let pageToken = '';
      for (let page = 0; page < 2; page++) {
        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
          { headers }
        );
        if (listRes.status === 401) {
          return { added: [], updated: [], nextCursor: cursor, expiredAuth: true, error: 'Gmail authorization expired' };
        }
        if (!listRes.ok) {
          return { added: [], updated: [], nextCursor: cursor, error: `Gmail sync failed (${listRes.status})` };
        }
        const listData = (await listRes.json()) as {
          messages?: Array<{ id: string; threadId: string }>;
          nextPageToken?: string;
        };
        listIds.push(...(listData.messages || []));
        pageToken = listData.nextPageToken || '';
        if (!pageToken) break;
      }

      for (const item of listIds.slice(0, 60)) {
        const payload = await this.fetchSingleMessage(item.id, headers, fresh.email);
        if (payload) added.push(payload);
      }

      let nextCursor = cursor || '';
      const profRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers });
      if (profRes.ok) {
        const prof = (await profRes.json()) as { historyId?: string };
        if (prof.historyId) nextCursor = prof.historyId;
      }

      return {
        added,
        updated: [],
        nextCursor,
        refreshedCredentials: refreshed ? fresh : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gmail sync error';
      return {
        added: [],
        updated: [],
        nextCursor: cursor,
        expiredAuth: msg === 'AUTH_EXPIRED',
        error: msg,
      };
    }
  }

  async sendMessage(credentials: ProviderCredentials, payload: SendMessagePayload): Promise<SendMessageResult> {
    if (credentials.type !== 'gmail') throw new Error('Invalid credential type for Gmail');
    const { creds: fresh } = await ensureFreshToken(credentials);

    const streamTransporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'unix',
      buffer: true,
    });
    const compiled = await streamTransporter.sendMail({
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

    const rawMime = (compiled.message as Buffer).toString('base64url');
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: rawMime }),
    });
    if (!res.ok) {
      throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
    }
    const sentData = (await res.json()) as { id: string; threadId: string };
    return {
      remoteId: sentData.id,
      remoteThreadId: sentData.threadId,
      messageIdHeader: compiled.messageId,
    };
  }

  async markRead(credentials: ProviderCredentials, remoteIds: string[], isRead: boolean): Promise<void> {
    if (credentials.type !== 'gmail' || remoteIds.length === 0) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: remoteIds,
        addLabelIds: isRead ? [] : ['UNREAD'],
        removeLabelIds: isRead ? ['UNREAD'] : [],
      }),
    });
  }

  async setStarred(credentials: ProviderCredentials, remoteIds: string[], isStarred: boolean): Promise<void> {
    if (credentials.type !== 'gmail' || remoteIds.length === 0) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: remoteIds,
        addLabelIds: isStarred ? ['STARRED'] : [],
        removeLabelIds: isStarred ? [] : ['STARRED'],
      }),
    });
  }

  async moveToFolder(credentials: ProviderCredentials, remoteIds: string[], targetFolderRemoteId: string): Promise<void> {
    if (credentials.type !== 'gmail' || remoteIds.length === 0) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];

    if (targetFolderRemoteId === 'archive') {
      removeLabelIds.push('INBOX', 'TRASH', 'SPAM');
    } else if (targetFolderRemoteId === 'trash' || targetFolderRemoteId === 'TRASH') {
      addLabelIds.push('TRASH');
      removeLabelIds.push('INBOX', 'SPAM');
    } else if (targetFolderRemoteId === 'spam' || targetFolderRemoteId === 'SPAM') {
      addLabelIds.push('SPAM');
      removeLabelIds.push('INBOX', 'TRASH');
    } else if (targetFolderRemoteId === 'inbox' || targetFolderRemoteId === 'INBOX') {
      addLabelIds.push('INBOX');
      removeLabelIds.push('TRASH', 'SPAM');
    } else {
      addLabelIds.push(targetFolderRemoteId);
    }

    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: remoteIds, addLabelIds, removeLabelIds }),
    });
  }

  async applyLabel(credentials: ProviderCredentials, remoteIds: string[], labelRemoteId: string): Promise<void> {
    if (credentials.type !== 'gmail' || remoteIds.length === 0 || !labelRemoteId) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: remoteIds, addLabelIds: [labelRemoteId], removeLabelIds: [] }),
    });
  }

  async removeLabel(credentials: ProviderCredentials, remoteIds: string[], labelRemoteId: string): Promise<void> {
    if (credentials.type !== 'gmail' || remoteIds.length === 0 || !labelRemoteId) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: remoteIds, addLabelIds: [], removeLabelIds: [labelRemoteId] }),
    });
  }

  async searchRemote(credentials: ProviderCredentials, query: string): Promise<RemoteMessagePayload[]> {
    if (credentials.type !== 'gmail' || !query.trim()) return [];
    const { creds: fresh } = await ensureFreshToken(credentials);
    const headers = { Authorization: `Bearer ${fresh.accessToken}` };
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`,
      { headers }
    );
    if (!listRes.ok) {
      throw new Error(`Gmail search failed (${listRes.status})`);
    }
    const listData = (await listRes.json()) as { messages?: Array<{ id: string }> };
    const results: RemoteMessagePayload[] = [];
    for (const m of (listData.messages || []).slice(0, 20)) {
      const payload = await this.fetchSingleMessage(m.id, headers, fresh.email);
      if (payload) results.push(payload);
    }
    return results;
  }

  async fetchContacts(credentials: ProviderCredentials): Promise<RemoteContactEntry[]> {
    if (credentials.type !== 'gmail') return [];
    try {
      const { creds: fresh } = await ensureFreshToken(credentials);
      const res = await fetch(
        'https://people.googleapis.com/v1/people/me/connections?pageSize=100&personFields=names,emailAddresses,organizations,phoneNumbers',
        { headers: { Authorization: `Bearer ${fresh.accessToken}` } }
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        connections?: Array<{
          resourceName: string;
          names?: Array<{ displayName?: string }>;
          emailAddresses?: Array<{ value?: string }>;
          organizations?: Array<{ name?: string }>;
          phoneNumbers?: Array<{ value?: string }>;
        }>;
      };
      const contacts: RemoteContactEntry[] = [];
      for (const c of data.connections || []) {
        const email = c.emailAddresses?.[0]?.value;
        if (!email) continue;
        contacts.push({
          remoteId: c.resourceName,
          name: c.names?.[0]?.displayName || email.split('@')[0],
          email,
          organization: c.organizations?.[0]?.name || '',
          phone: c.phoneNumbers?.[0]?.value || '',
        });
      }
      return contacts;
    } catch {
      return [];
    }
  }
}
