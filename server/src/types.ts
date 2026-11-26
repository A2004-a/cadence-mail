export type ProviderType = 'hosted' | 'local' | 'gmail' | 'outlook' | 'yahoo' | 'imap_smtp';

export type AccountOwnership = 'hosted' | 'external';

export type UserRole = 'admin' | 'member';

export type AccountStatus = 'connected' | 'syncing' | 'error' | 'auth_expired' | 'disconnected' | 'suspended';

export type DeliveryStatus =
  | 'draft'
  | 'queued'
  | 'accepted_local'
  | 'accepted_by_mx'
  | 'retry_pending'
  | 'bounced'
  | 'failed'
  | 'synced'
  | 'received';

export type SystemFolderRole =
  | 'inbox'
  | 'priority'
  | 'starred'
  | 'important'
  | 'sent'
  | 'drafts'
  | 'snoozed'
  | 'archive'
  | 'all'
  | 'spam'
  | 'trash'
  | 'custom';

export interface EmailParticipant {
  name: string;
  address: string;
}

export interface ProviderCapabilities {
  accountOwnership: AccountOwnership;
  supportsSend: boolean;
  supportsReceive: boolean;
  supportsSearch: boolean;
  supportsLabels: boolean;
  supportsFolders: boolean;
  supportsThreads: boolean;
  supportsDraftSync: boolean;
  supportsAttachments: boolean;
  supportsArchive: boolean;
  supportsDelete: boolean;
  supportsSpam: boolean;
  supportsReadState: boolean;
  supportsStarredState: boolean;
  supportsImportance: boolean;
  supportsIdle: boolean;
  supportsOAuth: boolean;
  supportsRemoteSearch: boolean;
  supportsPhishingReport: boolean;
  supportsScheduledSendNative: boolean;
  supportsRulesSync: boolean;
  supportsContactsSync: boolean;
  supportsAliases: boolean;
  supportsDkim: boolean;
  capabilityNotes?: Record<string, string>;
}

export interface SuspiciousLink {
  href: string;
  displayText: string;
  reason: string;
}

export interface SanitizedEmailResult {
  html: string;
  text: string;
  snippet: string;
  hasExternalImages: boolean;
  suspiciousLinks: SuspiciousLink[];
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

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  general: {
    language: 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    defaultFont: 'Onest, system-ui, sans-serif',
    defaultFontSize: '14px',
    dateFormat: 'relative',
    timeFormat: '12h',
  },
  appearance: {
    theme: 'system',
    accentColor: '#1D4ED8',
    sidebarCollapsed: false,
    layoutMode: 'split-right',
    density: 'comfortable',
    animationsEnabled: true,
  },
  inbox: {
    categoriesEnabled: true,
    conversationView: true,
    sortBy: 'date_desc',
    readingPaneAutoAdvance: 'next',
    priorityInboxEnabled: true,
  },
  email: {
    defaultReplyBehavior: 'reply',
    undoSendDelaySeconds: 8,
    autoMarkReadDelayMs: 600,
    loadExternalImages: 'ask',
    plainTextDefault: false,
  },
  notifications: {
    enabled: true,
    importantOnly: false,
    soundEnabled: false,
    desktopNotifications: true,
    showPreview: true,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
  categories: ['primary', 'work'],
  },
  ai: {
    enabled: false,
    privacyDisclosureAccepted: false,
    redactSensitiveContent: true,
    defaultTone: 'professional',
    defaultTargetLanguage: 'English',
    smartRepliesEnabled: true,
  },
  retention: {
    trashRetentionDays: 30,
    spamRetentionDays: 30,
  },
};
