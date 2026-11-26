import type { ProviderCapabilities, ProviderType } from '../types.js';
import { GMAIL_CAPABILITIES, GmailAdapter, isGmailOAuthConfigured } from './gmailAdapter.js';
import { HOSTED_CAPABILITIES, HostedProviderAdapter } from './hostedAdapter.js';
import { IMAP_SMTP_CAPABILITIES, ImapSmtpAdapter, YAHOO_CAPABILITIES } from './imapSmtpAdapter.js';
import { LOCAL_CAPABILITIES, LocalProviderAdapter } from './localAdapter.js';
import { OUTLOOK_CAPABILITIES, OutlookAdapter, isOutlookOAuthConfigured } from './outlookAdapter.js';
import type { EmailProviderAdapter } from './types.js';

const imapAdapter = new ImapSmtpAdapter();

const adapters: Record<ProviderType, EmailProviderAdapter> = {
  hosted: new HostedProviderAdapter(),
  local: new LocalProviderAdapter(),
  imap_smtp: imapAdapter,
  yahoo: imapAdapter,
  gmail: new GmailAdapter(),
  outlook: new OutlookAdapter(),
};

export function getProviderAdapter(providerType: ProviderType): EmailProviderAdapter {
  return adapters[providerType] || adapters.imap_smtp;
}

export function getProviderCapabilities(providerType: ProviderType): ProviderCapabilities {
  switch (providerType) {
    case 'hosted':
      return HOSTED_CAPABILITIES;
    case 'local':
      return LOCAL_CAPABILITIES;
    case 'yahoo':
      return YAHOO_CAPABILITIES;
    case 'imap_smtp':
      return IMAP_SMTP_CAPABILITIES;
    case 'gmail':
      return GMAIL_CAPABILITIES;
    case 'outlook':
      return OUTLOOK_CAPABILITIES;
  }
}

export function getProviderSetupStatus() {
  return {
    hosted: {
      available: true,
      configured: true,
      description: 'Independent Cadence-hosted email service with custom domains, DKIM signing, incoming MX, and outbound MTA delivery.',
    },
    local: {
      available: true,
      configured: true,
      description: 'Offline workspace sandbox mailbox for local testing without external email connectivity.',
    },
    gmail: {
      available: true,
      configured: isGmailOAuthConfigured(),
      description: 'Google OAuth 2.0 + Gmail REST API with incremental sync, labels, and search (or App Password via IMAP).',
      missingEnv: isGmailOAuthConfigured() ? [] : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    },
    outlook: {
      available: true,
      configured: isOutlookOAuthConfigured(),
      description: 'Microsoft 365 / Outlook OAuth 2.0 + Microsoft Graph API with delta sync, folders, and search.',
      missingEnv: isOutlookOAuthConfigured() ? [] : ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    },
    yahoo: {
      available: true,
      configured: true,
      description: 'Yahoo Mail IMAP + SMTP integration using Yahoo App Passwords and remote folder sync.',
    },
    imap_smtp: {
      available: true,
      configured: true,
      description: 'Connect any standard IMAP + SMTP provider (Fastmail, iCloud, Zoho, Proton Bridge, custom server).',
    },
  };
}
