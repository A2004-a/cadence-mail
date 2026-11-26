import React, { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  MailCheck,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { ApiError, apiRequest } from '../api/client';

export interface ProviderPreset {
  id: 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'zoho' | 'fastmail' | 'custom';
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  hint: string;
}

export const MAIL_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'Enable IMAP in Gmail settings and use a 16-character Google App Password (myaccount.google.com/apppasswords) if 2-Step Verification is active.',
  },
  {
    id: 'outlook',
    label: 'Outlook / M365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    smtpSecure: false,
    hint: 'Personal Hotmail/Outlook/Live accounts often require OAuth2 or an App Password depending on Microsoft security policies.',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'Generate a Yahoo App Password under Account Security before connecting.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpSecure: false,
    hint: 'Requires an app-specific password generated from appleid.apple.com.',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'Use imap.zoho.com (or imap.zoho.in / .eu depending on your Zoho region).',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'Create a Fastmail App Password with Mail + SMTP access under Privacy & Security -> Integrations.',
  },
  {
    id: 'custom',
    label: 'Custom Server',
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    smtpHost: '',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'Enter your domain or organization IMAP & SMTP hostnames, ports, and TLS settings.',
  },
];

interface ConnectRealMailPanelProps {
  defaultName?: string;
  onConnected: () => Promise<void>;
  compact?: boolean;
  onOpenAdmin?: () => void;
}

export function ConnectRealMailPanel({ defaultName = '', onConnected, compact = false, onOpenAdmin }: ConnectRealMailPanelProps) {
  const [connectMode, setConnectMode] = useState<'external' | 'hosted'>('external');
  const [presetId, setPresetId] = useState<ProviderPreset['id']>('gmail');
  const [availableDomains, setAvailableDomains] = useState<Array<{ id: string; domain: string; ownershipVerified: boolean; internalOnly: boolean }>>([]);
  const [hostedDomainId, setHostedDomainId] = useState('');
  const [hostedLocalPart, setHostedLocalPart] = useState('');
  const [providerStatus, setProviderStatus] = useState<{
    providers?: Record<string, { configured: boolean }>;
    ai?: {
      configured: boolean;
      activeProvider: string | null;
      model?: string | null;
      providersConfigured?: { gemini: boolean; openai: boolean; anthropic: boolean };
      models?: { gemini: string; openai: string; openaiBaseUrl: string; anthropic: string };
    };
    oauthConfig?: { microsoftTenantId: string; isDesktopLoopback: boolean };
    oauthRedirectUris?: { gmail: string; outlook: string };
    canConfigureServerProviders?: boolean;
  } | null>(null);

  const [displayName, setDisplayName] = useState(defaultName);
  const [emailAddress, setEmailAddress] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [imapHost, setImapHost] = useState('imap.gmail.com');
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com');
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [serverEditedManually, setServerEditedManually] = useState(false);

  const [busy, setBusy] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [oauthSetupOpen, setOauthSetupOpen] = useState(false);
  const [includeCalendarScope, setIncludeCalendarScope] = useState(false);
  const [copiedUri, setCopiedUri] = useState<'gmail' | 'outlook' | null>(null);

  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [microsoftClientId, setMicrosoftClientId] = useState('');
  const [microsoftClientSecret, setMicrosoftClientSecret] = useState('');
  const [microsoftTenantId, setMicrosoftTenantId] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');

  async function refreshStatus() {
    try {
      const [s, doms] = await Promise.all([
        apiRequest<any>('/accounts/providers/status'),
        apiRequest<{ domains: Array<{ id: string; domain: string; ownershipVerified: boolean; internalOnly: boolean }> }>('/accounts/domains/available'),
      ]);
      setProviderStatus(s);
      setAvailableDomains(doms.domains || []);
      if (!hostedDomainId && doms.domains?.length > 0) {
        setHostedDomainId(doms.domains[0].id);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  function applyPreset(nextId: ProviderPreset['id'], resetManual = true) {
    setPresetId(nextId);
    if (resetManual) setServerEditedManually(nextId === 'custom');
    const p = MAIL_PROVIDER_PRESETS.find((item) => item.id === nextId);
    if (!p) return;
    setImapHost(p.imapHost);
    setImapPort(p.imapPort);
    setImapSecure(p.imapSecure);
    setSmtpHost(p.smtpHost);
    setSmtpPort(p.smtpPort);
    setSmtpSecure(p.smtpSecure);
    if (nextId === 'custom') setAdvancedOpen(true);
    setFeedback(null);
  }

  function autoDetectPresetFromEmail(rawEmail: string) {
    if (serverEditedManually) return;
    const at = rawEmail.lastIndexOf('@');
    if (at === -1) return;
    const domain = rawEmail.slice(at + 1).trim().toLowerCase();
    if (!domain || !domain.includes('.')) return;

    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      if (presetId !== 'gmail') applyPreset('gmail', false);
    } else if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) {
      if (presetId !== 'outlook') applyPreset('outlook', false);
    } else if (['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.in', 'yahoo.co.uk'].includes(domain)) {
      if (presetId !== 'yahoo') applyPreset('yahoo', false);
    } else if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) {
      if (presetId !== 'icloud') applyPreset('icloud', false);
    } else if (domain === 'zoho.com' || domain === 'zohomail.com' || domain === 'zoho.in' || domain === 'zohomail.in' || domain === 'zohomail.eu' || domain === 'zoho.eu') {
      applyPreset('zoho', false);
      if (domain.endsWith('.in')) {
        setImapHost('imap.zoho.in');
        setSmtpHost('smtp.zoho.in');
      } else if (domain.endsWith('.eu')) {
        setImapHost('imap.zoho.eu');
        setSmtpHost('smtp.zoho.eu');
      }
    } else if (domain === 'fastmail.com' || domain === 'fastmail.fm') {
      if (presetId !== 'fastmail') applyPreset('fastmail', false);
    }
  }

  const activePreset = MAIL_PROVIDER_PRESETS.find((p) => p.id === presetId) || MAIL_PROVIDER_PRESETS[0];

  function buildPayload() {
    return {
      providerType: presetId === 'yahoo' ? ('yahoo' as const) : ('imap_smtp' as const),
      displayName: displayName.trim() || emailAddress.split('@')[0] || 'My Mailbox',
      emailAddress: emailAddress.trim(),
      imapHost: imapHost.trim(),
      imapPort,
      imapSecure,
      smtpHost: smtpHost.trim(),
      smtpPort,
      smtpSecure,
      username: (usernameEdited ? username : emailAddress).trim(),
      password,
    };
  }

  async function handleTest() {
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest('/accounts/test-imap', { method: 'POST', body: buildPayload() });
      setFeedback({ type: 'ok', text: 'IMAP receive and SMTP send verified! Click "Connect & Sync Real Mail" to import your inbox.' });
    } catch (err: any) {
      setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : 'Connection failed' });
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ accountId: string; sync?: { ok: boolean; added: number; error?: string } }>('/accounts/imap', {
        method: 'POST',
        body: buildPayload(),
      });
      const added = res.sync?.added ?? 0;
      setFeedback({
        type: 'ok',
        text: `Connected ${emailAddress.trim()} and synchronized ${added} message(s).`,
      });
      setPassword('');
      await onConnected();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to connect mailbox' });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateHosted(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ accountId: string; emailAddress: string }>('/accounts/hosted', {
        method: 'POST',
        body: {
          domainId: hostedDomainId,
          localPart: hostedLocalPart.trim(),
          displayName: displayName.trim() || hostedLocalPart.trim(),
          setDefault: true,
        },
      });
      setFeedback({ type: 'ok', text: `Created platform-hosted mailbox ${res.emailAddress}!` });
      setHostedLocalPart('');
      await onConnected();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to create hosted mailbox' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 12 : 16, textAlign: 'left' }}>
      {/* Hybrid Mode Chooser + Wizard Progress */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className={`btn btn-sm ${connectMode === 'external' ? 'btn-primary' : ''}`}
            onClick={() => {
              setConnectMode('external');
              setFeedback(null);
            }}
          >
            Connect External Email (Gmail / Outlook / IMAP)
          </button>
          <button
            type="button"
            className={`btn btn-sm ${connectMode === 'hosted' ? 'btn-primary' : ''}`}
            onClick={() => {
              setConnectMode('hosted');
              setFeedback(null);
            }}
          >
            Create Own Hosted Email Address
          </button>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          1. Mode &rarr; 2. Verify &rarr; 3. Sync
        </span>
      </div>

      {connectMode === 'hosted' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {availableDomains.length === 0 ? (
            <div style={{ padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5, lineHeight: 1.5 }}>
              <strong>No active hosted domain configured yet.</strong>
              <p style={{ margin: '6px 0 8px', color: 'var(--text-secondary)' }}>
                To host independent email addresses on your own infrastructure (Mode A), register a domain and verify DNS or activate internal delivery inside Administration &rarr; Domains &amp; DNS.
              </p>
              {onOpenAdmin && (
                <button type="button" className="btn btn-sm btn-primary" onClick={onOpenAdmin}>
                  Open Infrastructure Admin &rarr; Domains
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={handleCreateHosted} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Display Name</label>
                  <input className="field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Alex Rivera" required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Mailbox Username</label>
                  <input className="field" value={hostedLocalPart} onChange={(e) => setHostedLocalPart(e.target.value)} placeholder="alex" required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Hosted Domain</label>
                  <select className="field" value={hostedDomainId} onChange={(e) => setHostedDomainId(e.target.value)}>
                    {availableDomains.map((d) => (
                      <option key={d.id} value={d.id}>@{d.domain} {d.ownershipVerified ? '(DNS Verified)' : '(Internal)'}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Capabilities: Full Native Inbox, DKIM Outbound Signing, Aliases, Rules, Scheduled Send &amp; Instant Local Delivery.
              </div>
              {feedback && (
                <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-md)', background: feedback.type === 'ok' ? 'var(--status-success-bg)' : 'var(--status-danger-bg)', color: feedback.type === 'ok' ? 'var(--status-success)' : 'var(--status-danger)', fontSize: 12.5 }}>
                  {feedback.text}
                </div>
              )}
              <div>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  <MailCheck size={14} /> {busy ? 'Provisioning...' : 'Create Hosted Mailbox'}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : (
      <>
      {/* Provider Presets */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
          1. Select your email provider
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {MAIL_PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`btn btn-sm ${presetId === p.id ? 'btn-primary' : ''}`}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-subtle)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.45,
          }}
        >
          {activePreset.hint}
        </div>
      </div>

      {/* Direct OAuth buttons if configured */}
      {(providerStatus?.providers?.gmail?.configured || providerStatus?.providers?.outlook?.configured) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {providerStatus?.providers?.gmail?.configured && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    const qs = includeCalendarScope ? '?includeCalendar=true' : '';
                    const res = await apiRequest<{ authUrl: string }>(`/accounts/oauth/gmail/start${qs}`);
                    window.location.href = res.authUrl;
                  } catch (err) {
                    setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to start Google OAuth2 sign-in.' });
                  }
                }}
              >
                <ExternalLink size={13} /> Sign in with Google OAuth2
                <CheckCircle2 size={13} color="var(--status-success)" />
              </button>
            )}
            {providerStatus?.providers?.outlook?.configured && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    const qs = includeCalendarScope ? '?includeCalendar=true' : '';
                    const res = await apiRequest<{ authUrl: string }>(`/accounts/oauth/outlook/start${qs}`);
                    window.location.href = res.authUrl;
                  } catch (err) {
                    setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to start Microsoft OAuth2 sign-in.' });
                  }
                }}
              >
                <ExternalLink size={13} /> Sign in with Microsoft OAuth2
                <CheckCircle2 size={13} color="var(--status-success)" />
              </button>
            )}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={includeCalendarScope}
              onChange={(e) => setIncludeCalendarScope(e.target.checked)}
            />
            Request optional read-only Calendar OAuth scope (`calendar.readonly` / `Calendars.Read`)
          </label>
        </div>
      )}

      {/* Real IMAP/SMTP Credentials Form */}
      <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Your Name</label>
            <input
              className="field"
              placeholder="Alex Rivera"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Real Email Address</label>
            <input
              type="email"
              className="field"
              placeholder="you@gmail.com"
              value={emailAddress}
              onChange={(e) => {
                const nextVal = e.target.value;
                setEmailAddress(nextVal);
                if (!usernameEdited) setUsername(nextVal);
                autoDetectPresetFromEmail(nextVal);
              }}
              required
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>
              App Password / Password
            </label>
            <input
              type="password"
              className="field"
              placeholder="16-char App Password or mailbox password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ paddingLeft: 0, height: 24, fontSize: 12 }}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Server Settings ({imapHost || 'host'}:{imapPort} · {smtpHost || 'smtp'}:{smtpPort})
          </button>

          {advancedOpen && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-hairline)',
                background: 'var(--bg-subtle)',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                gap: 8,
              }}
            >
              <div>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>IMAP Host</label>
                <input
                  className="field"
                  value={imapHost}
                  onChange={(e) => {
                    setServerEditedManually(true);
                    setImapHost(e.target.value);
                  }}
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>IMAP Port</label>
                <input
                  type="number"
                  className="field"
                  value={imapPort}
                  onChange={(e) => {
                    const p = Number(e.target.value);
                    setServerEditedManually(true);
                    setImapPort(p);
                    setImapSecure(p === 993);
                  }}
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>SMTP Host</label>
                <input
                  className="field"
                  value={smtpHost}
                  onChange={(e) => {
                    setServerEditedManually(true);
                    setSmtpHost(e.target.value);
                  }}
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>SMTP Port</label>
                <input
                  type="number"
                  className="field"
                  value={smtpPort}
                  onChange={(e) => {
                    const p = Number(e.target.value);
                    setServerEditedManually(true);
                    setSmtpPort(p);
                    setSmtpSecure(p === 465);
                  }}
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>Login Username</label>
                <input
                  className="field"
                  value={usernameEdited ? username : emailAddress}
                  onChange={(e) => {
                    setUsernameEdited(true);
                    setUsername(e.target.value);
                  }}
                  required
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 4, fontSize: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />
                  IMAP SSL/TLS
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
                  SMTP Implicit TLS (port 465)
                </label>
              </div>
            </div>
          )}
        </div>

        {feedback && (
          <div
            role={feedback.type === 'err' ? 'alert' : 'status'}
            style={{
              padding: '9px 12px',
              borderRadius: 'var(--radius-md)',
              background: feedback.type === 'ok' ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
              color: feedback.type === 'ok' ? 'var(--status-success)' : 'var(--status-danger)',
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          >
            {feedback.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            disabled={busy || !emailAddress.trim() || !password}
            onClick={() => void handleTest()}
          >
            <ShieldCheck size={14} /> Test Connection
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <MailCheck size={14} /> {busy ? 'Connecting & Syncing...' : 'Connect & Sync Real Mail'}
          </button>
        </div>
      </form>

      {/* Optional OAuth2 & AI Keys configuration directly from UI */}
      <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ paddingLeft: 0, height: 24, fontSize: 12 }}
          onClick={() => setOauthSetupOpen((v) => !v)}
        >
          {oauthSetupOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <KeyRound size={12} /> Configure OAuth2 App / AI API Keys (Optional)
        </button>

        {oauthSetupOpen && (
          <div
            style={{
              marginTop: 8,
              padding: 12,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-hairline)',
              background: 'var(--bg-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              fontSize: 12,
            }}
          >
            {providerStatus?.canConfigureServerProviders === false ? (
              <div style={{ color: 'var(--status-warning)', lineHeight: 1.45 }}>
                Server-wide OAuth2 Client IDs and AI API keys can only be modified by an Administrator. Ask your workspace admin to configure OAuth/AI credentials, or connect your mailbox directly above using IMAP/SMTP + App Password.
              </div>
            ) : (
              <>
                <div style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Save OAuth 2.0 app credentials and/or server-side AI keys (Gemini, OpenAI, or Anthropic) directly to your local Cadence profile. Leave fields blank to keep existing saved values.
                </div>
                {providerStatus?.oauthRedirectUris && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {providerStatus.oauthConfig?.isDesktopLoopback && (
                      <div style={{ color: 'var(--accent)', fontSize: 11.5 }}>
                        Desktop Loopback Mode active: register these exact <code>127.0.0.1</code> callback URLs in Google Cloud / Microsoft Entra (or set <code>CADENCE_EXPLICIT_PORT=1</code> &amp; <code>PORT=4280</code> in <code>.env</code>).
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>Gmail Callback:</span>
                      <code>{providerStatus.oauthRedirectUris.gmail}</code>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ height: 20, padding: '0 6px', fontSize: 11 }}
                        onClick={async () => {
                          await navigator.clipboard?.writeText(providerStatus.oauthRedirectUris!.gmail);
                          setCopiedUri('gmail');
                          setTimeout(() => setCopiedUri(null), 1800);
                        }}
                      >
                        {copiedUri === 'gmail' ? <Check size={11} /> : <Copy size={11} />}
                        {copiedUri === 'gmail' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>Outlook Callback:</span>
                      <code>{providerStatus.oauthRedirectUris.outlook}</code>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ height: 20, padding: '0 6px', fontSize: 11 }}
                        onClick={async () => {
                          await navigator.clipboard?.writeText(providerStatus.oauthRedirectUris!.outlook);
                          setCopiedUri('outlook');
                          setTimeout(() => setCopiedUri(null), 1800);
                        }}
                      >
                        {copiedUri === 'outlook' ? <Check size={11} /> : <Copy size={11} />}
                        {copiedUri === 'outlook' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                  <input className="field" placeholder="Google OAuth Client ID" value={googleClientId} onChange={(e) => setGoogleClientId(e.target.value)} />
                  <input type="password" className="field" placeholder="Google OAuth Client Secret" value={googleClientSecret} onChange={(e) => setGoogleClientSecret(e.target.value)} />
                  <input className="field" placeholder="Microsoft OAuth Client ID" value={microsoftClientId} onChange={(e) => setMicrosoftClientId(e.target.value)} />
                  <input type="password" className="field" placeholder="Microsoft OAuth Client Secret" value={microsoftClientSecret} onChange={(e) => setMicrosoftClientSecret(e.target.value)} />
                  <input
                    className="field"
                    placeholder={`Microsoft Tenant ID (${providerStatus?.oauthConfig?.microsoftTenantId || 'common'})`}
                    value={microsoftTenantId}
                    onChange={(e) => setMicrosoftTenantId(e.target.value)}
                  />
                  <input type="password" className="field" placeholder="Gemini API Key" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} />
                  <input type="password" className="field" placeholder="OpenAI API Key" value={openaiApiKey} onChange={(e) => setOpenaiApiKey(e.target.value)} />
                  <input
                    className="field"
                    placeholder={`OpenAI Base URL (${providerStatus?.ai?.models?.openaiBaseUrl || 'https://api.openai.com/v1'})`}
                    value={openaiBaseUrl}
                    onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                  />
                  <input
                    className="field"
                    placeholder={`OpenAI Model (${providerStatus?.ai?.models?.openai || 'gpt-4o-mini'})`}
                    value={openaiModel}
                    onChange={(e) => setOpenaiModel(e.target.value)}
                  />
                  <input type="password" className="field" placeholder="Anthropic API Key" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} />
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={savingKeys}
                    onClick={async () => {
                      const payload: Record<string, string> = {};
                      if (googleClientId.trim()) payload.googleClientId = googleClientId.trim();
                      if (googleClientSecret.trim()) payload.googleClientSecret = googleClientSecret.trim();
                      if (microsoftClientId.trim()) payload.microsoftClientId = microsoftClientId.trim();
                      if (microsoftClientSecret.trim()) payload.microsoftClientSecret = microsoftClientSecret.trim();
                      if (microsoftTenantId.trim()) payload.microsoftTenantId = microsoftTenantId.trim();
                      if (geminiApiKey.trim()) payload.geminiApiKey = geminiApiKey.trim();
                      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
                      if (openaiBaseUrl.trim()) payload.openaiBaseUrl = openaiBaseUrl.trim();
                      if (openaiModel.trim()) payload.openaiModel = openaiModel.trim();
                      if (anthropicApiKey.trim()) payload.anthropicApiKey = anthropicApiKey.trim();

                      if (Object.keys(payload).length === 0) {
                        setFeedback({ type: 'err', text: 'Enter at least one OAuth2 or AI key field before saving.' });
                        return;
                      }
                      setSavingKeys(true);
                      setFeedback(null);
                      try {
                        await apiRequest('/accounts/providers/configure', { method: 'POST', body: payload });
                        setGoogleClientId('');
                        setGoogleClientSecret('');
                        setMicrosoftClientId('');
                        setMicrosoftClientSecret('');
                        setMicrosoftTenantId('');
                        setGeminiApiKey('');
                        setOpenaiApiKey('');
                        setOpenaiBaseUrl('');
                        setOpenaiModel('');
                        setAnthropicApiKey('');
                        await refreshStatus();
                        setFeedback({ type: 'ok', text: 'Provider / AI credentials saved locally and activated.' });
                      } catch (err) {
                        setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : 'Failed to save provider keys.' });
                      } finally {
                        setSavingKeys(false);
                      }
                    }}
                  >
                    <Sparkles size={12} /> {savingKeys ? 'Saving...' : 'Save Keys Locally'}
                  </button>

                  {(['google', 'microsoft', 'gemini', 'openai', 'anthropic'] as const).map((group) => {
                    const isConfigured =
                      group === 'google'
                        ? Boolean(providerStatus?.providers?.gmail?.configured)
                        : group === 'microsoft'
                        ? Boolean(providerStatus?.providers?.outlook?.configured)
                        : Boolean(providerStatus?.ai?.providersConfigured?.[group]);
                    if (!isConfigured) return null;
                    const label =
                      group === 'google'
                        ? 'Gmail OAuth'
                        : group === 'microsoft'
                        ? 'Outlook OAuth'
                        : group === 'gemini'
                        ? 'Gemini Key'
                        : group === 'openai'
                        ? 'OpenAI Key'
                        : 'Anthropic Key';
                    return (
                      <button
                        key={group}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ height: 22, fontSize: 11, color: 'var(--status-danger)' }}
                        disabled={savingKeys}
                        onClick={async () => {
                          setSavingKeys(true);
                          try {
                            await apiRequest('/accounts/providers/configure', {
                              method: 'POST',
                              body: { clearKeys: [group] },
                            });
                            await refreshStatus();
                            setFeedback({ type: 'ok', text: `Cleared ${label}.` });
                          } catch (err) {
                            setFeedback({ type: 'err', text: err instanceof ApiError ? err.message : `Unable to clear ${label}.` });
                          } finally {
                            setSavingKeys(false);
                          }
                        }}
                      >
                        <Trash2 size={11} /> Clear {label}
                      </button>
                    );
                  })}
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Gmail OAuth: {providerStatus?.providers?.gmail?.configured ? 'Ready' : 'Not set'} · Outlook OAuth:{' '}
                  {providerStatus?.providers?.outlook?.configured ? 'Ready' : 'Not set'} · AI:{' '}
                  {providerStatus?.ai?.configured ? `${providerStatus.ai.activeProvider} (${providerStatus.ai.model})` : 'Not set'}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
