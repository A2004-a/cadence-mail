import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { getDb } from '../db/database.js';
import { getDecryptedDkimForAddress } from '../services/domainService.js';
import type { ProviderCapabilities } from '../types.js';
import type {
  EmailProviderAdapter,
  ProviderCredentials,
  RemoteFolder,
  RemoteLabel,
  SendMessagePayload,
  SendMessageResult,
  SyncResult,
} from './types.js';

export const HOSTED_CAPABILITIES: ProviderCapabilities = {
  accountOwnership: 'hosted',
  supportsSend: true,
  supportsReceive: true,
  supportsSearch: true,
  supportsLabels: true,
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
  supportsOAuth: false,
  supportsRemoteSearch: false,
  supportsPhishingReport: true,
  supportsScheduledSendNative: true,
  supportsRulesSync: true,
  supportsContactsSync: false,
  supportsAliases: true,
  supportsDkim: true,
  capabilityNotes: {
    remoteSearch: 'This mailbox is hosted natively on Cadence; FTS5 search indexes all mail.',
    oauth: 'Protected by your Cadence account password & SMTP submission credentials.',
  },
};

export class HostedProviderAdapter implements EmailProviderAdapter {
  readonly providerType = 'hosted' as const;
  readonly capabilities = HOSTED_CAPABILITIES;

  async testConnection(credentials: ProviderCredentials): Promise<{ ok: boolean; error?: string }> {
    if (credentials.type !== 'hosted') {
      return { ok: false, error: 'Invalid credentials for hosted mailbox' };
    }
    const db = getDb();
    const dom = db.prepare('SELECT status FROM domains WHERE id = ?').get(credentials.domainId) as
      | { status: string }
      | undefined;
    if (dom && dom.status === 'disabled') {
      return { ok: false, error: 'Hosting domain is currently disabled by administrator' };
    }
    return { ok: true };
  }

  async fetchFolders(_credentials: ProviderCredentials): Promise<RemoteFolder[]> {
    return [
      { remoteId: 'inbox', name: 'Inbox', slug: 'inbox', systemRole: 'inbox' },
      { remoteId: 'sent', name: 'Sent', slug: 'sent', systemRole: 'sent' },
      { remoteId: 'drafts', name: 'Drafts', slug: 'drafts', systemRole: 'drafts' },
      { remoteId: 'archive', name: 'Archive', slug: 'archive', systemRole: 'archive' },
      { remoteId: 'spam', name: 'Spam', slug: 'spam', systemRole: 'spam' },
      { remoteId: 'trash', name: 'Trash', slug: 'trash', systemRole: 'trash' },
    ];
  }

  async fetchLabels(_credentials: ProviderCredentials): Promise<RemoteLabel[]> {
    return [];
  }

  async syncChanges(_credentials: ProviderCredentials, cursor: string): Promise<SyncResult> {
    return {
      added: [],
      updated: [],
      nextCursor: cursor || new Date().toISOString(),
    };
  }

  async sendMessage(_credentials: ProviderCredentials, payload: SendMessagePayload): Promise<SendMessageResult> {
    const db = getDb();
    const domain = (payload.fromAddress.split('@')[1] || 'cadence.local').trim().toLowerCase();
    const messageIdHeader = `<${crypto.randomUUID()}@${domain}>`;
    const dkim = getDecryptedDkimForAddress(db, payload.fromAddress);

    // Pre-validate MIME synthesis cleanly (actual signed delivery happens through mailDeliveryEngine)
    const transporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'unix',
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

    await transporter.sendMail({
      from: payload.fromName ? `"${payload.fromName}" <${payload.fromAddress}>` : payload.fromAddress,
      to: payload.to.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
      cc: payload.cc.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
      bcc: payload.bcc.map((r) => (r.name ? `"${r.name}" <${r.address}>` : r.address)),
      subject: payload.subject,
      html: payload.html || undefined,
      text: payload.text || undefined,
      messageId: messageIdHeader,
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
      remoteId: crypto.randomUUID(),
      messageIdHeader,
    };
  }
}
