export type ProviderType = 'hosted' | 'local' | 'gmail' | 'outlook' | 'yahoo' | 'imap_smtp';

export type AccountOwnership = 'hosted' | 'external';

export interface EmailParticipant {
  name: string;
  address: string;
}

export interface ProviderCapabilities {
  accountOwnership?: AccountOwnership;
  supportsSend?: boolean;
  supportsReceive?: boolean;
  supportsSearch?: boolean;
  supportsLabels: boolean;
  supportsFolders: boolean;
  supportsThreads: boolean;
  supportsDraftSync: boolean;
  supportsAttachments?: boolean;
  supportsArchive?: boolean;
  supportsDelete?: boolean;
  supportsSpam?: boolean;
  supportsReadState?: boolean;
  supportsStarredState?: boolean;
  supportsImportance?: boolean;
  supportsIdle: boolean;
  supportsOAuth: boolean;
  supportsRemoteSearch: boolean;
  supportsPhishingReport: boolean;
  supportsScheduledSendNative: boolean;
  supportsRulesSync?: boolean;
  supportsContactsSync?: boolean;
  supportsAliases?: boolean;
  supportsDkim?: boolean;
  capabilityNotes?: Record<string, string>;
}

export interface Account {
  id: string;
  providerType: ProviderType;
  accountOwnership?: AccountOwnership;
  domainId?: string | null;
  emailAddress: string;
  displayName: string;
  avatarColor: string;
  signatureHtml: string;
  signatureEnabled: boolean;
  status: 'connected' | 'syncing' | 'error' | 'auth_expired' | 'disconnected' | 'suspended';
  isDefault?: boolean;
  quotaMb?: number;
  usedBytes?: number;
  capabilities: ProviderCapabilities;
  lastSyncedAt: string | null;
  lastError: string | null;
  notificationPrefs: { enabled?: boolean; importantOnly?: boolean; soundEnabled?: boolean };
  unreadCount: number;
}

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  slug: string;
  systemRole: string;
  parentId: string | null;
  color: string;
  sortOrder: number;
  isFavorite: boolean;
  unreadCount: number;
}

export interface Label {
  id: string;
  accountId: string | null;
  name: string;
  color: string;
  sortOrder: number;
  isFavorite: boolean;
  threadCount: number;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  color: string;
  enabled: boolean;
  sortOrder: number;
  description: string;
}

export interface ThreadSummary {
  id: string;
  accountId: string;
  accountEmail: string;
  accountName: string;
  accountColor: string;
  providerType: ProviderType;
  subject: string;
  snippet: string;
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  isStarred: boolean;
  isImportant: boolean;
  isPinned: boolean;
  inInbox: boolean;
  inSent: boolean;
  inArchive: boolean;
  inSpam: boolean;
  inTrash: boolean;
  hasAttachments: boolean;
  categorySlug: string;
  priorityScore: number;
  participants: EmailParticipant[];
  snoozedUntil: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
  syncPending?: boolean;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentId: string;
  isInline: boolean;
}

export interface SuspiciousLink {
  href: string;
  displayText: string;
  reason: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  accountId: string;
  messageIdHeader: string;
  inReplyTo: string;
  folderId: string | null;
  folderName: string | null;
  folderRole: string | null;
  fromName: string;
  fromAddress: string;
  to: EmailParticipant[];
  cc: EmailParticipant[];
  bcc: EmailParticipant[];
  replyTo: EmailParticipant[];
  subject: string;
  bodyHtmlSanitized: string;
  bodyText: string;
  snippet: string;
  hasExternalImages: boolean;
  suspiciousLinks: SuspiciousLink[];
  authResults: Record<string, string>;
  listUnsubscribe?: { httpUrl?: string; mailto?: string } | null;
  sentAt: string;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isArchived: boolean;
  hasAttachments: boolean;
  categorySlug: string;
  sizeBytes: number;
  deliveryStatus?: 'draft' | 'queued' | 'accepted_local' | 'accepted_by_mx' | 'retry_pending' | 'bounced' | 'failed' | 'synced' | 'received';
  deliveryDetail?: string;
  attachments: AttachmentMeta[];
  labels: Array<{ id: string; name: string; color: string }>;
}

export interface Draft {
  id: string;
  accountId: string;
  threadId: string | null;
  replyToMessageId: string | null;
  mode: 'new' | 'reply' | 'reply_all' | 'forward';
  to: EmailParticipant[];
  cc: EmailParticipant[];
  bcc: EmailParticipant[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  isPlainText: boolean;
  status: 'draft' | 'queued_undo' | 'sending' | 'scheduled' | 'sent' | 'failed';
  scheduledFor: string | null;
  scheduledTimezone: string;
  undoSendUntil: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentMeta[];
}

export interface Contact {
  id: string;
  accountId?: string | null;
  source?: 'local' | 'provider_synced';
  name: string;
  email: string;
  organization: string;
  phone: string;
  notes: string;
  avatarColor: string;
  isFavorite: boolean;
  contactCount: number;
  lastContactedAt: string | null;
  customFields?: Record<string, string>;
  groups: Array<{ id: string; name: string; color: string }>;
}

export interface RuleCondition {
  field:
    | 'from'
    | 'to'
    | 'subject'
    | 'body'
    | 'keywords'
    | 'domain'
    | 'has_attachment'
    | 'date_after'
    | 'date_before'
    | 'label'
    | 'category'
    | 'is_read'
    | 'is_starred'
    | 'is_important';
  operator: 'contains' | 'contains_any' | 'regex' | 'not_contains' | 'equals' | 'starts_with' | 'ends_with' | 'is_true' | 'is_false' | 'after' | 'before';
  value: string;
}

export interface RuleAction {
  type:
    | 'move_to_folder'
    | 'apply_label'
    | 'mark_read'
    | 'mark_unread'
    | 'mark_important'
    | 'archive'
    | 'star'
    | 'skip_inbox'
    | 'notify'
    | 'categorize'
    | 'forward'
    | 'create_task'
    | 'create_reminder'
    | 'create_event'
    | 'generate_draft'
    | 'auto_reply';
  value?: string;
  subject?: string;
  attachmentIds?: string[];
  infoProfileIds?: string[];
  includeOriginalAttachments?: boolean;
}

export interface Rule {
  id: string;
  accountId: string | null;
  name: string;
  enabled: boolean;
  priorityOrder: number;
  matchMode: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing: boolean;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  category: string;
  shortcutKey: string;
  updatedAt: string;
}

export interface Reminder {
  id: string;
  threadId: string | null;
  messageId: string | null;
  threadSubject: string | null;
  title: string;
  dueAt: string;
  status: 'pending' | 'triggered' | 'dismissed' | 'completed';
}

export interface NotificationItem {
  id: string;
  accountId: string | null;
  threadId: string | null;
  messageId: string | null;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

export interface UserPreferences {
  general: {
    language: string;
    timezone: string;
    defaultFont: string;
    defaultFontSize: string;
    dateFormat: 'relative' | 'short' | 'iso';
    timeFormat: '12h' | '24h';
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
    accentColor: string;
    sidebarCollapsed: boolean;
    layoutMode: 'list' | 'split-right' | 'split-bottom' | 'full-reading';
    density: 'compact' | 'comfortable' | 'spacious';
    animationsEnabled: boolean;
  };
  inbox: {
    categoriesEnabled: boolean;
    conversationView: boolean;
    sortBy: 'date_desc' | 'date_asc' | 'priority' | 'sender';
    readingPaneAutoAdvance: 'next' | 'prev' | 'list';
    priorityInboxEnabled: boolean;
  };
  email: {
    defaultReplyBehavior: 'reply' | 'reply_all';
    undoSendDelaySeconds: number;
    autoMarkReadDelayMs: number;
    loadExternalImages: 'ask' | 'always' | 'never';
    plainTextDefault: boolean;
  };
  notifications: {
    enabled: boolean;
    importantOnly: boolean;
    soundEnabled: boolean;
    desktopNotifications: boolean;
    showPreview: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    categories: string[];
  };
  ai: {
    enabled: boolean;
    privacyDisclosureAccepted: boolean;
    redactSensitiveContent: boolean;
    defaultTone: 'professional' | 'formal' | 'friendly' | 'neutral' | 'polite' | 'confident' | 'concise';
    defaultTargetLanguage: string;
    smartRepliesEnabled: boolean;
  };
  retention?: {
    trashRetentionDays: number;
    spamRetentionDays: number;
  };
}

export type ActiveWorkspaceSection =
  | 'mail'
  | 'tasks'
  | 'calendar'
  | 'attachments'
  | 'collaboration'
  | 'contacts'
  | 'rules'
  | 'templates'
  | 'reminders'
  | 'settings'
  | 'admin';

export interface SavedSearch {
  id: string;
  accountId: string | null;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSignature {
  id: string;
  accountId: string;
  name: string;
  bodyHtml: string;
  bodyText: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskItem {
  id: string;
  title: string;
  notes: string;
  status: 'todo' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  category: string;
  dueAt: string | null;
  reminderAt: string | null;
  threadId: string | null;
  threadSubject?: string | null;
  messageId: string | null;
  contactId: string | null;
  contactName?: string | null;
  attachmentId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  accountId: string | null;
  threadId: string | null;
  threadSubject?: string | null;
  messageId: string | null;
  title: string;
  description: string;
  location: string;
  meetingUrl: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees: EmailParticipant[];
  reminderMinutes: number;
  source: 'local' | 'extracted' | 'ics' | 'google' | 'outlook';
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentLibraryItem {
  id: string;
  messageId: string | null;
  threadId: string | null;
  threadSubject: string | null;
  accountId: string | null;
  accountEmail: string | null;
  fromName: string | null;
  fromAddress: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  duplicateCount: number;
  createdAt: string;
}

export interface RuleExecutionLog {
  id: string;
  ruleId: string;
  ruleName?: string;
  messageId: string | null;
  threadId: string | null;
  status: 'executed' | 'skipped_guard' | 'failed';
  detail: string;
  executedAt: string;
}

export interface SharedMailbox {
  id: string;
  name: string;
  description: string;
  accountId: string;
  emailAddress: string;
  ownerUserId: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  memberCount: number;
  openThreads: number;
  createdAt: string;
}

export interface ThreadNote {
  id: string;
  threadId: string;
  mailboxId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface AiWorkflowRun {
  id: string;
  threadId: string | null;
  workflowType: string;
  prompt: string;
  plan: Array<{
    stepType: 'create_task' | 'create_reminder' | 'create_event' | 'create_draft' | 'organize_thread';
    title: string;
    description: string;
    reversible: boolean;
    payload: Record<string, any>;
  }>;
  status: 'planned' | 'awaiting_confirmation' | 'executed' | 'cancelled' | 'failed';
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SecurityCenterData {
  posture: Array<{ id: string; label: string; status: 'ok' | 'warning'; detail: string }>;
  loginHistory: Array<{ id: string; eventType: string; severity: string; ipAddress: string; createdAt: string; details: Record<string, any> }>;
  oauthPermissions: Array<{ accountId: string; emailAddress: string; providerType: string; status: string; scopes: string[] }>;
  storage: { totalBytes: number; attachmentsBytes: number; accounts: Array<{ id: string; emailAddress: string; usedBytes: number; quotaMb: number }> };
}

export interface SearchMeta {
  scope: 'local_fts5_and_cache' | 'hybrid_local_and_remote';
  remoteQueried: boolean;
  hasPartialFailures: boolean;
  accountStatuses: Array<{
    accountId: string;
    emailAddress: string;
    providerType: string;
    ownership: string;
    scope: 'local_index' | 'remote_merged';
    status: 'ok' | 'disconnected' | 'failed';
    remoteMatches: number;
    error?: string;
  }>;
}

export type MailView =
  | 'inbox'
  | 'priority'
  | 'unread'
  | 'starred'
  | 'important'
  | 'sent'
  | 'drafts'
  | 'snoozed'
  | 'archive'
  | 'all'
  | 'spam'
  | 'trash'
  | 'folder'
  | 'label'
  | 'search';

export interface ViewCounts {
  inboxUnread: number;
  inboxTotal: number;
  priorityUnread: number;
  starred: number;
  important: number;
  snoozed: number;
  spam: number;
  trash: number;
  drafts: number;
  categories: Record<string, { total: number; unread: number }>;
}

export interface AutomationAsset {
  id: string;
  name: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AutomationInfoProfile {
  id: string;
  slug: string;
  kind: 'location' | 'contact' | 'document' | 'custom';
  title: string;
  contentText: string;
  mapQuery: string;
  mapUrl: string;
  effectiveMapUrl: string;
  attachmentIds: string[];
  attachments: AutomationAsset[];
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledAutomation {
  id: string;
  accountId: string;
  accountEmail: string;
  name: string;
  enabled: boolean;
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'interval_hours';
  timeOfDay: string;
  timezone: string;
  daysOfWeek: number[];
  dayOfMonth: number;
  intervalHours: number;
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  bcc: Array<{ name: string; address: string }>;
  subject: string;
  bodyText: string;
  infoProfileIds: string[];
  attachmentIds: string[];
  attachments: AutomationAsset[];
  maxRuns: number | null;
  runCount: number;
  lastRunAt: string | null;
  nextRunAt: string;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledAutomationLog {
  id: string;
  automationId: string;
  automationName: string | null;
  draftId: string | null;
  status: 'sent' | 'failed' | 'skipped';
  detail: string;
  executedAt: string;
}
