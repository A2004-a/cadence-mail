import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.js';
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

export const LOCAL_CAPABILITIES: ProviderCapabilities = {
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
  supportsScheduledSendNative: false,
  supportsRulesSync: true,
  supportsContactsSync: false,
  supportsAliases: true,
  supportsDkim: true,
  capabilityNotes: {
    remoteSearch: 'All messages reside locally on this server; FTS5 search covers 100% of mailbox content.',
    oauth: 'Authenticated directly with your Cadence workspace account.',
  },
};

export class LocalProviderAdapter implements EmailProviderAdapter {
  readonly providerType = 'local' as const;
  readonly capabilities = LOCAL_CAPABILITIES;

  async testConnection(_credentials: ProviderCredentials): Promise<{ ok: boolean; error?: string }> {
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
    const id = crypto.randomUUID();
    const domain = payload.fromAddress.split('@')[1] || 'cadence.local';
    const messageIdHeader = `<${id}@${domain}>`;
    return {
      remoteId: id,
      messageIdHeader,
      remoteThreadId: undefined,
    };
  }
}

export function findLocalRecipientAccounts(
  db: DatabaseSync,
  addresses: string[]
): Array<{ accountId: string; userId: string; emailAddress: string; displayName: string }> {
  if (addresses.length === 0) return [];
  const normalized = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const results: Array<{ accountId: string; userId: string; emailAddress: string; displayName: string }> = [];
  const stmt = db.prepare(
    `SELECT id AS accountId, user_id AS userId, email_address AS emailAddress, display_name AS displayName
     FROM accounts
     WHERE provider_type = 'local' AND status != 'disconnected' AND lower(email_address) = ?`
  );
  for (const addr of normalized) {
    const row = stmt.get(addr) as
      | { accountId: string; userId: string; emailAddress: string; displayName: string }
      | undefined;
    if (row) results.push(row);
  }
  return results;
}

export function getLocalAdapter(): LocalProviderAdapter {
  return new LocalProviderAdapter();
}
