import { config } from '../config.js';
import type { EmailParticipant, ProviderCapabilities, SystemFolderRole } from '../types.js';
import type {
  EmailProviderAdapter,
  OAuthCredentials,
  ProviderCredentials,
  RemoteFolder,
  RemoteLabel,
  RemoteMessagePayload,
  SendMessagePayload,
  SendMessageResult,
  SyncResult,
} from './types.js';

export const OUTLOOK_CAPABILITIES: ProviderCapabilities = {
  accountOwnership: 'external',
  supportsSend: true,
  supportsReceive: true,
  supportsSearch: true,
  supportsLabels: false,
  supportsFolders: true,
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
  supportsPhishingReport: false,
  supportsScheduledSendNative: false,
  supportsRulesSync: false,
  supportsContactsSync: false,
  supportsAliases: false,
  supportsDkim: false,
  capabilityNotes: {
    labels: 'Microsoft Graph exposes mail folders rather than Gmail-style multi-labels; labels stay local in Cadence.',
    phishingReport: 'Moving messages to Junk Email works via Graph; Microsoft phishing telemetry API is not used.',
  },
};

export function isOutlookOAuthConfigured(): boolean {
  return Boolean(config.oauth.microsoft.clientId && config.oauth.microsoft.clientSecret);
}

export function buildOutlookAuthUrl(state: string, codeChallenge: string, includeCalendar = false): string {
  const tenant = config.oauth.microsoft.tenantId || 'common';
  const scopes = ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'];
  if (includeCalendar) {
    scopes.push('Calendars.Read');
  }
  const params = new URLSearchParams({
    client_id: config.oauth.microsoft.clientId,
    response_type: 'code',
    redirect_uri: config.oauth.microsoft.redirectUri,
    response_mode: 'query',
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeOutlookCode(code: string, codeVerifier: string): Promise<OAuthCredentials> {
  const tenant = config.oauth.microsoft.tenantId || 'common';
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.oauth.microsoft.clientId,
      client_secret: config.oauth.microsoft.clientSecret,
      code,
      redirect_uri: config.oauth.microsoft.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Microsoft OAuth token exchange failed: ${await res.text()}`);
  }
  const tokenData = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!meRes.ok) throw new Error('Failed to fetch Microsoft Graph profile');
  const me = (await meRes.json()) as { mail?: string; userPrincipalName: string };
  return {
    type: 'outlook',
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || '',
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    scope: tokenData.scope,
    email: me.mail || me.userPrincipalName,
  };
}

async function ensureFreshToken(creds: OAuthCredentials): Promise<{ creds: OAuthCredentials; refreshed: boolean }> {
  if (creds.expiresAt > Date.now() + 60_000) return { creds, refreshed: false };
  if (!creds.refreshToken || !isOutlookOAuthConfigured()) {
    throw new Error('AUTH_EXPIRED');
  }
  const tenant = config.oauth.microsoft.tenantId || 'common';
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.oauth.microsoft.clientId,
      client_secret: config.oauth.microsoft.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('AUTH_EXPIRED');
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

function mapGraphRecipients(list?: Array<{ emailAddress?: { name?: string; address?: string } }>): EmailParticipant[] {
  return (list || [])
    .filter((r) => Boolean(r.emailAddress?.address))
    .map((r) => ({
      name: r.emailAddress?.name || '',
      address: r.emailAddress?.address || '',
    }));
}

function inferFolderRole(name: string): SystemFolderRole {
  const lower = name.toLowerCase();
  if (lower === 'inbox') return 'inbox';
  if (lower.includes('sent')) return 'sent';
  if (lower.includes('draft')) return 'drafts';
  if (lower.includes('deleted') || lower.includes('trash')) return 'trash';
  if (lower.includes('junk') || lower.includes('spam')) return 'spam';
  if (lower.includes('archive')) return 'archive';
  return 'custom';
}

export class OutlookAdapter implements EmailProviderAdapter {
  readonly providerType = 'outlook' as const;
  readonly capabilities = OUTLOOK_CAPABILITIES;

  async testConnection(credentials: ProviderCredentials): Promise<{ ok: boolean; error?: string }> {
    if (credentials.type !== 'outlook') return { ok: false, error: 'Invalid credentials for Outlook' };
    try {
      const { creds: fresh } = await ensureFreshToken(credentials);
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${fresh.accessToken}` },
      });
      if (!res.ok) return { ok: false, error: `Microsoft Graph returned ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Outlook connection failed' };
    }
  }

  async fetchFolders(credentials: ProviderCredentials): Promise<RemoteFolder[]> {
    if (credentials.type !== 'outlook') return [];
    const { creds: fresh } = await ensureFreshToken(credentials);
    const res = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders', {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { value?: Array<{ id: string; displayName: string }> };
    return (data.value || []).map((f) => ({
      remoteId: f.id,
      name: f.displayName,
      slug: f.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      systemRole: inferFolderRole(f.displayName),
    }));
  }

  async fetchLabels(_credentials: ProviderCredentials): Promise<RemoteLabel[]> {
    return [];
  }

  async syncChanges(credentials: ProviderCredentials, cursor: string): Promise<SyncResult> {
    if (credentials.type !== 'outlook') {
      return { added: [], updated: [], nextCursor: cursor, error: 'Invalid credentials' };
    }
    try {
      const { creds: fresh, refreshed } = await ensureFreshToken(credentials);
      let folderLinks: Record<string, string> = {};
      if (cursor) {
        if (cursor.startsWith('https://graph.microsoft.com')) {
          folderLinks.inbox = cursor;
        } else {
          try {
            const parsed = JSON.parse(cursor);
            if (parsed?.folderLinks) folderLinks = parsed.folderLinks;
          } catch {
            // ignore
          }
        }
      }

      const folderTargets: Array<{ graphId: string; role: SystemFolderRole }> = [
        { graphId: 'inbox', role: 'inbox' },
        { graphId: 'sentitems', role: 'sent' },
        { graphId: 'drafts', role: 'drafts' },
        { graphId: 'archive', role: 'archive' },
        { graphId: 'junkemail', role: 'spam' },
        { graphId: 'deleteditems', role: 'trash' },
      ];

      const added: RemoteMessagePayload[] = [];
      const nextLinks: Record<string, string> = { ...folderLinks };

      for (const ft of folderTargets) {
        const endpoint =
          folderLinks[ft.graphId] ||
          `https://graph.microsoft.com/v1.0/me/mailFolders/${ft.graphId}/messages/delta?$top=25`;
        const res = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${fresh.accessToken}` },
        });
        if (res.status === 401) {
          return { added: [], updated: [], nextCursor: cursor, expiredAuth: true, error: 'Outlook authorization expired' };
        }
        if (!res.ok) {
          if (ft.graphId === 'inbox') {
            return { added: [], updated: [], nextCursor: cursor, error: `Graph API sync failed (${res.status})` };
          }
          continue;
        }
        const data = (await res.json()) as {
          '@odata.deltaLink'?: string;
          value?: Array<{
            id: string;
            conversationId?: string;
            internetMessageId?: string;
            subject?: string;
            body?: { contentType?: string; content?: string };
            bodyPreview?: string;
            hasAttachments?: boolean;
            from?: { emailAddress?: { name?: string; address?: string } };
            toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
            ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
            bccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
            sentDateTime?: string;
            receivedDateTime?: string;
            isRead?: boolean;
            flag?: { flagStatus?: string };
            importance?: string;
            isDraft?: boolean;
          }>;
        };

        for (const m of data.value || []) {
          const attachments = [];
          if (m.hasAttachments) {
            try {
              const attRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}/attachments`, {
                headers: { Authorization: `Bearer ${fresh.accessToken}` },
              });
              if (attRes.ok) {
                const attData = (await attRes.json()) as {
                  value?: Array<{ name?: string; contentType?: string; contentBytes?: string; size?: number; contentId?: string; isInline?: boolean }>;
                };
                for (const a of (attData.value || []).slice(0, 8)) {
                  if (!a.contentBytes || (a.size || 0) > 5 * 1024 * 1024) continue;
                  attachments.push({
                    filename: a.name || 'attachment',
                    mimeType: a.contentType || 'application/octet-stream',
                    content: Buffer.from(a.contentBytes, 'base64'),
                    contentId: a.contentId,
                    isInline: Boolean(a.isInline),
                  });
                }
              }
            } catch {
              // ignore non-fatal attachment hydration errors
            }
          }

          added.push({
            remoteId: m.id,
            remoteThreadId: m.conversationId,
            messageIdHeader: m.internetMessageId || `<${m.id}@outlook.office365.com>`,
            inReplyTo: '',
            referencesHeader: '',
            folderRole: ft.role,
            fromName: m.from?.emailAddress?.name || '',
            fromAddress: m.from?.emailAddress?.address || fresh.email,
            to: mapGraphRecipients(m.toRecipients),
            cc: mapGraphRecipients(m.ccRecipients),
            bcc: mapGraphRecipients(m.bccRecipients),
            replyTo: [],
            subject: m.subject || '(no subject)',
            rawHtml: m.body?.contentType?.toLowerCase() === 'html' ? m.body.content || '' : '',
            rawText: m.body?.contentType?.toLowerCase() === 'text' ? m.body.content || '' : m.bodyPreview || '',
            sentAt: m.sentDateTime || new Date().toISOString(),
            receivedAt: m.receivedDateTime || new Date().toISOString(),
            isRead: Boolean(m.isRead),
            isStarred: m.flag?.flagStatus === 'flagged',
            isImportant: m.importance === 'high',
            isDraft: Boolean(m.isDraft) || ft.role === 'drafts',
            isSpam: ft.role === 'spam',
            isTrash: ft.role === 'trash',
            isArchived: ft.role === 'archive',
            attachments,
          });
        }
        if (data['@odata.deltaLink']) {
          nextLinks[ft.graphId] = data['@odata.deltaLink'];
        }
      }

      return {
        added,
        updated: [],
        nextCursor: JSON.stringify({ folderLinks: nextLinks }),
        refreshedCredentials: refreshed ? fresh : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Outlook sync failed';
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
    if (credentials.type !== 'outlook') throw new Error('Invalid credential type for Outlook');
    const { creds: fresh } = await ensureFreshToken(credentials);
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: payload.subject,
          body: {
            contentType: payload.html ? 'HTML' : 'Text',
            content: payload.html || payload.text,
          },
          toRecipients: payload.to.map((r) => ({ emailAddress: { name: r.name || undefined, address: r.address } })),
          ccRecipients: payload.cc.map((r) => ({ emailAddress: { name: r.name || undefined, address: r.address } })),
          bccRecipients: payload.bcc.map((r) => ({ emailAddress: { name: r.name || undefined, address: r.address } })),
          attachments: payload.attachments.map((att) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.filename,
            contentType: att.mimeType,
            contentBytes: att.content.toString('base64'),
            isInline: Boolean(att.isInline),
            contentId: att.contentId,
          })),
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Outlook send failed (${res.status}): ${await res.text()}`);
    }
    const id = crypto.randomUUID();
    return {
      remoteId: id,
      messageIdHeader: `<${id}@cadence.outlook>`,
    };
  }

  async markRead(credentials: ProviderCredentials, remoteIds: string[], isRead: boolean): Promise<void> {
    if (credentials.type !== 'outlook' || remoteIds.length === 0) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    for (const id of remoteIds) {
      await fetch(`https://graph.microsoft.com/v1.0/me/messages/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${fresh.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isRead }),
      });
    }
  }

  async setStarred(credentials: ProviderCredentials, remoteIds: string[], isStarred: boolean): Promise<void> {
    if (credentials.type !== 'outlook' || remoteIds.length === 0) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    for (const id of remoteIds) {
      await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${fresh.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flag: { flagStatus: isStarred ? 'flagged' : 'notFlagged' } }),
      });
    }
  }

  async moveToFolder(credentials: ProviderCredentials, remoteIds: string[], targetFolderRemoteId: string): Promise<void> {
    if (credentials.type !== 'outlook' || remoteIds.length === 0) return;
    const { creds: fresh } = await ensureFreshToken(credentials);
    const wellKnownMap: Record<string, string> = {
      inbox: 'inbox',
      archive: 'archive',
      trash: 'deleteditems',
      spam: 'junkemail',
      drafts: 'drafts',
      sent: 'sentitems',
    };
    const destinationId = wellKnownMap[targetFolderRemoteId.toLowerCase()] || targetFolderRemoteId;
    for (const id of remoteIds) {
      await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fresh.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destinationId }),
      });
    }
  }

  async searchRemote(credentials: ProviderCredentials, query: string): Promise<RemoteMessagePayload[]> {
    if (credentials.type !== 'outlook' || !query.trim()) return [];
    const { creds: fresh } = await ensureFreshToken(credentials);
    const sanitizedQ = query.replace(/"/g, ' ').trim();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent(`"${sanitizedQ}"`)}&$top=20`,
      {
        headers: {
          Authorization: `Bearer ${fresh.accessToken}`,
          ConsistencyLevel: 'eventual',
        },
      }
    );
    if (!res.ok) throw new Error(`Outlook search failed (${res.status})`);
    const data = (await res.json()) as { value?: Array<any> };
    return (data.value || []).map((m) => ({
      remoteId: m.id,
      remoteThreadId: m.conversationId,
      messageIdHeader: m.internetMessageId || `<${m.id}@outlook.office365.com>`,
      inReplyTo: '',
      referencesHeader: '',
      folderRole: 'inbox',
      fromName: m.from?.emailAddress?.name || '',
      fromAddress: m.from?.emailAddress?.address || fresh.email,
      to: mapGraphRecipients(m.toRecipients),
      cc: mapGraphRecipients(m.ccRecipients),
      bcc: mapGraphRecipients(m.bccRecipients),
      replyTo: [],
      subject: m.subject || '(no subject)',
      rawHtml: m.body?.contentType?.toLowerCase() === 'html' ? m.body.content || '' : '',
      rawText: m.body?.contentType?.toLowerCase() === 'text' ? m.body.content || '' : m.bodyPreview || '',
      sentAt: m.sentDateTime || new Date().toISOString(),
      receivedAt: m.receivedDateTime || new Date().toISOString(),
      isRead: Boolean(m.isRead),
      isStarred: m.flag?.flagStatus === 'flagged',
      isImportant: m.importance === 'high',
      isDraft: Boolean(m.isDraft),
      isSpam: false,
      isTrash: false,
      isArchived: false,
      attachments: [],
    }));
  }
}
