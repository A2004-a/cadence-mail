import type { EmailParticipant, ProviderCapabilities, ProviderType, SystemFolderRole } from '../types.js';

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  content: Buffer;
  contentId?: string;
  isInline?: boolean;
}

export interface RemoteMessagePayload {
  remoteId: string;
  remoteThreadId?: string;
  messageIdHeader: string;
  inReplyTo: string;
  referencesHeader: string;
  folderRole?: SystemFolderRole;
  folderRemoteId?: string;
  fromName: string;
  fromAddress: string;
  to: EmailParticipant[];
  cc: EmailParticipant[];
  bcc: EmailParticipant[];
  replyTo: EmailParticipant[];
  subject: string;
  rawHtml: string;
  rawText: string;
  sentAt: string;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isDraft: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isArchived: boolean;
  labelNames?: string[];
  authResults?: Record<string, string>;
  rawHeaders?: Record<string, string>;
  attachments: AttachmentInput[];
}

export interface SendMessagePayload {
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
}

export interface SendMessageResult {
  remoteId: string;
  messageIdHeader: string;
  remoteThreadId?: string;
}

export interface RemoteFolder {
  remoteId: string;
  name: string;
  slug: string;
  systemRole: SystemFolderRole;
}

export interface RemoteLabel {
  remoteId: string;
  name: string;
  color?: string;
}

export interface SyncResult {
  added: RemoteMessagePayload[];
  updated: Array<{
    remoteId: string;
    isRead?: boolean;
    isStarred?: boolean;
    isImportant?: boolean;
    isTrash?: boolean;
    isSpam?: boolean;
    isArchived?: boolean;
  }>;
  nextCursor: string;
  expiredAuth?: boolean;
  error?: string;
  refreshedCredentials?: OAuthCredentials;
}

export interface HostedCredentials {
  type: 'hosted';
  domainId: string;
}

export interface LocalCredentials {
  type: 'local';
}

export interface ImapSmtpCredentials {
  type: 'imap_smtp' | 'yahoo';
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
}

export interface OAuthCredentials {
  type: 'gmail' | 'outlook';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  email: string;
}

export type ProviderCredentials = HostedCredentials | LocalCredentials | ImapSmtpCredentials | OAuthCredentials;

export interface RemoteContactEntry {
  remoteId: string;
  name: string;
  email: string;
  organization?: string;
  phone?: string;
}

export interface EmailProviderAdapter {
  readonly providerType: ProviderType;
  readonly capabilities: ProviderCapabilities;
  testConnection(credentials: ProviderCredentials): Promise<{ ok: boolean; error?: string }>;
  fetchFolders(credentials: ProviderCredentials): Promise<RemoteFolder[]>;
  fetchLabels(credentials: ProviderCredentials): Promise<RemoteLabel[]>;
  syncChanges(credentials: ProviderCredentials, cursor: string): Promise<SyncResult>;
  sendMessage(credentials: ProviderCredentials, payload: SendMessagePayload): Promise<SendMessageResult>;
  markRead?(credentials: ProviderCredentials, remoteIds: string[], isRead: boolean): Promise<void>;
  setStarred?(credentials: ProviderCredentials, remoteIds: string[], isStarred: boolean): Promise<void>;
  moveToFolder?(credentials: ProviderCredentials, remoteIds: string[], targetFolderRemoteId: string): Promise<void>;
  applyLabel?(credentials: ProviderCredentials, remoteIds: string[], labelRemoteId: string): Promise<void>;
  removeLabel?(credentials: ProviderCredentials, remoteIds: string[], labelRemoteId: string): Promise<void>;
  searchRemote?(credentials: ProviderCredentials, query: string): Promise<RemoteMessagePayload[]>;
  fetchContacts?(credentials: ProviderCredentials): Promise<RemoteContactEntry[]>;
}
