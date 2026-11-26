import { useEffect, useState } from 'react';
import {
  Download,
  ExternalLink,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react';
import { ApiError, apiRequest } from '../api/client';
import type { Account, AccountSignature, Category, SecurityCenterData, UserPreferences } from '../types';
import { ACCENT_PRESETS, formatBytes } from './CadenceMark';
import { ConnectRealMailPanel } from './ConnectRealMailPanel';

interface SettingsViewProps {
  preferences: UserPreferences;
  accounts: Account[];
  categories: Category[];
  onUpdatePreferences: (patch: Record<string, any>) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  onLogout: () => Promise<void>;
}

type SettingsTab = 'general' | 'appearance' | 'inbox' | 'email' | 'notifications' | 'ai' | 'accounts';

export function SettingsView(props: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [aiStatus, setAiStatus] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [blockedSenders, setBlockedSenders] = useState<any[]>([]);
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [openSyncLogAcctId, setOpenSyncLogAcctId] = useState<string | null>(null);
  const [syncLogs, setSyncLogs] = useState<Array<{ id: string; status: string; messages_added: number; messages_updated: number; duration_ms: number; error_message: string | null; created_at: string }>>([]);
  const [securityCenter, setSecurityCenter] = useState<SecurityCenterData | null>(null);
  const [signatures, setSignatures] = useState<AccountSignature[]>([]);
  const [newSigName, setNewSigName] = useState('');
  const [newSigHtml, setNewSigHtml] = useState('');
  const [newSigDefault, setNewSigDefault] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatColor, setNewCatColor] = useState('#2563EB');

  // Local Offline Sandbox Mailbox form (optional)
  const [localEmail, setLocalEmail] = useState('');
  const [localName, setLocalName] = useState('');
  const [localSeed, setLocalSeed] = useState(false);

  // External account credential rotation / reconnect state
  const [updatingCredAcctId, setUpdatingCredAcctId] = useState<string | null>(null);
  const [updPassword, setUpdPassword] = useState('');
  const [updUsername, setUpdUsername] = useState('');
  const [updImapHost, setUpdImapHost] = useState('');
  const [updImapPort, setUpdImapPort] = useState('');
  const [updSmtpHost, setUpdSmtpHost] = useState('');
  const [updSmtpPort, setUpdSmtpPort] = useState('');
  const [credBusy, setCredBusy] = useState(false);

  // Signature editor per account
  const [sigAcctId, setSigAcctId] = useState(props.accounts[0]?.id || '');
  const activeSigAccount = props.accounts.find((a) => a.id === sigAcctId) || props.accounts[0];
  const [sigHtml, setSigHtml] = useState(activeSigAccount?.signatureHtml || '');

  useEffect(() => {
    if (activeSigAccount) setSigHtml(activeSigAccount.signatureHtml);
  }, [sigAcctId, props.accounts]);

  async function loadDiagnostics() {
    const [aiRes, sesRes, blkRes, secRes, sigRes] = await Promise.all([
      apiRequest('/productivity/ai/status'),
      apiRequest<{ sessions: any[] }>('/auth/sessions'),
      apiRequest<{ blockedSenders: any[] }>('/org/blocked-senders'),
      apiRequest<SecurityCenterData>('/auth/security-center'),
      apiRequest<{ signatures: AccountSignature[] }>('/workspace/signatures'),
    ]);
    setAiStatus(aiRes);
    setSessions(sesRes.sessions);
    setBlockedSenders(blkRes.blockedSenders);
    setSecurityCenter(secRes);
    setSignatures(sigRes.signatures || []);
  }

  useEffect(() => {
    void loadDiagnostics();
  }, []);

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'inbox', label: 'Inbox & Categories' },
    { id: 'email', label: 'Email & Signatures' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'ai', label: 'AI & Privacy' },
    { id: 'accounts', label: 'Accounts & Security' },
  ];

  const { preferences } = props;

  return (
    <div className="cadence-subview-shell">
      {/* Settings Nav */}
      <div className="cadence-subview-nav">
        <strong style={{ fontSize: 13.5, padding: '4px 10px 8px' }}>Settings</strong>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              textAlign: 'left',
              height: 33,
              padding: '0 10px',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              background: tab === t.id ? 'var(--accent-soft)' : 'transparent',
              color: tab === t.id ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: tab === t.id ? 600 : 500,
              fontSize: 13,
            }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--border-hairline)' }}>
          <button type="button" className="btn btn-sm" style={{ width: '100%' }} onClick={() => void props.onLogout()}>
            <LogOut size={13} /> Sign Out
          </button>
        </div>
      </div>

      {/* Settings Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {banner && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                background: banner.type === 'ok' ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
                color: banner.type === 'ok' ? 'var(--status-success)' : 'var(--status-danger)',
                fontSize: 13,
              }}
            >
              {banner.text}
            </div>
          )}

          {tab === 'general' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>General Preferences</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Language</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.general.language}
                    onChange={(e) => void props.onUpdatePreferences({ general: { language: e.target.value } })}
                  >
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Time Zone</label>
                  <input
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.general.timezone}
                    onChange={(e) => void props.onUpdatePreferences({ general: { timezone: e.target.value } })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Date Format</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.general.dateFormat}
                    onChange={(e) => void props.onUpdatePreferences({ general: { dateFormat: e.target.value } })}
                  >
                    <option value="relative">Relative (10:15 AM, Tue, Nov 26)</option>
                    <option value="short">Short date</option>
                    <option value="iso">ISO (2026-11-26)</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Time Format</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.general.timeFormat}
                    onChange={(e) => void props.onUpdatePreferences({ general: { timeFormat: e.target.value } })}
                  >
                    <option value="12h">12-hour</option>
                    <option value="24h">24-hour</option>
                  </select>
                </div>
              </div>
            </section>
          )}

          {tab === 'appearance' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Appearance & Layout</h2>
              <div>
                <label style={{ fontSize: 12.5, fontWeight: 500 }}>Theme Mode</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  {(['light', 'dark', 'system'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`btn ${preferences.appearance.theme === m ? 'btn-primary' : ''}`}
                      style={{ textTransform: 'capitalize' }}
                      onClick={() => void props.onUpdatePreferences({ appearance: { theme: m } })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12.5, fontWeight: 500 }}>Accent Color</label>
                <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                  {ACCENT_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="btn btn-sm"
                      style={{
                        borderColor: preferences.appearance.accentColor === preset.light ? preset.light : 'var(--border-hairline)',
                        background: preferences.appearance.accentColor === preset.light ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                      }}
                      onClick={() => void props.onUpdatePreferences({ appearance: { accentColor: preset.light } })}
                    >
                      <span style={{ width: 12, height: 12, borderRadius: 99, background: preset.light }} />
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Reading Layout</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.appearance.layoutMode}
                    onChange={(e) => void props.onUpdatePreferences({ appearance: { layoutMode: e.target.value } })}
                  >
                    <option value="split-right">Split Right Pane</option>
                    <option value="split-bottom">Split Bottom Pane</option>
                    <option value="list">Traditional Full List</option>
                    <option value="full-reading">Full Reading Focus</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Row Density</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.appearance.density}
                    onChange={(e) => void props.onUpdatePreferences({ appearance: { density: e.target.value } })}
                  >
                    <option value="compact">Compact</option>
                    <option value="comfortable">Comfortable</option>
                    <option value="spacious">Spacious</option>
                  </select>
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.appearance.animationsEnabled}
                  onChange={(e) => void props.onUpdatePreferences({ appearance: { animationsEnabled: e.target.checked } })}
                />
                Enable subtle UI transitions
              </label>
            </section>
          )}

          {tab === 'inbox' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Inbox Organization & Categories</h2>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.inbox.priorityInboxEnabled}
                  onChange={(e) => void props.onUpdatePreferences({ inbox: { priorityInboxEnabled: e.target.checked } })}
                />
                Enable Priority Inbox scoring
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.inbox.categoriesEnabled}
                  onChange={(e) => void props.onUpdatePreferences({ inbox: { categoriesEnabled: e.target.checked } })}
                />
                Show Category tabs above Inbox
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <strong style={{ fontSize: 13 }}>Configure Categories</strong>
                {props.categories.map((cat) => (
                  <div
                    key={cat.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={cat.enabled}
                        onChange={async (e) => {
                          await apiRequest(`/org/categories/${cat.id}`, {
                            method: 'PATCH',
                            body: { enabled: e.target.checked },
                          });
                          await props.onRefreshAll();
                        }}
                      />
                      <span style={{ width: 10, height: 10, borderRadius: 99, background: cat.color }} />
                      <input
                        className="field"
                        style={{ height: 28, width: 150, fontSize: 12.5 }}
                        defaultValue={cat.name}
                        onBlur={async (e) => {
                          if (e.target.value.trim() && e.target.value !== cat.name) {
                            await apiRequest(`/org/categories/${cat.id}`, {
                              method: 'PATCH',
                              body: { name: e.target.value.trim() },
                            });
                            await props.onRefreshAll();
                          }
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cat.description}</span>
                      {cat.slug !== 'primary' && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          style={{ width: 24, height: 24 }}
                          onClick={async () => {
                            await apiRequest(`/org/categories/${cat.id}`, { method: 'DELETE' });
                            await props.onRefreshAll();
                          }}
                          aria-label={`Delete category ${cat.name}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newCatName.trim()) return;
                    await apiRequest('/org/categories', { method: 'POST', body: { name: newCatName.trim(), color: newCatColor } });
                    setNewCatName('');
                    await props.onRefreshAll();
                  }}
                  style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}
                >
                  <input className="field" style={{ flex: 1, minWidth: 160 }} placeholder="Add custom category..." value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
                  <input type="color" value={newCatColor} onChange={(e) => setNewCatColor(e.target.value)} style={{ width: 38, height: 34, padding: 2, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', background: 'transparent' }} />
                  <button type="submit" className="btn btn-sm"><Plus size={13} /> Add Category</button>
                </form>
              </div>
            </section>
          )}

          {tab === 'email' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Email Sending, Privacy & Signatures</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>Undo Send Delay (seconds)</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.email.undoSendDelaySeconds}
                    onChange={(e) => void props.onUpdatePreferences({ email: { undoSendDelaySeconds: Number(e.target.value) } })}
                  >
                    <option value={0}>Immediate (0s)</option>
                    <option value={5}>5 seconds</option>
                    <option value={8}>8 seconds</option>
                    <option value={15}>15 seconds</option>
                    <option value={30}>30 seconds</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 500 }}>External Images Policy</label>
                  <select
                    className="field"
                    style={{ marginTop: 4 }}
                    value={preferences.email.loadExternalImages}
                    onChange={(e) => void props.onUpdatePreferences({ email: { loadExternalImages: e.target.value } })}
                  >
                    <option value="ask">Ask before loading (Recommended)</option>
                    <option value="never">Always block external images</option>
                    <option value="always">Always load images</option>
                  </select>
                </div>
              </div>

              {activeSigAccount && (
                <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 13 }}>Account Signature</strong>
                    <select
                      className="field"
                      style={{ width: 'auto', height: 30, fontSize: 12 }}
                      value={activeSigAccount.id}
                      onChange={(e) => setSigAcctId(e.target.value)}
                    >
                      {props.accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.emailAddress}</option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    className="field"
                    rows={4}
                    value={sigHtml}
                    onChange={(e) => setSigHtml(e.target.value)}
                    placeholder="<p>Best regards,<br>Your Name</p>"
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={async () => {
                      await apiRequest(`/accounts/${activeSigAccount.id}`, {
                        method: 'PATCH',
                        body: { signatureHtml: sigHtml },
                      });
                      await props.onRefreshAll();
                      setBanner({ type: 'ok', text: 'Default account signature saved.' });
                    }}
                  >
                    Save Default Signature
                  </button>

                  <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <strong style={{ fontSize: 12.5 }}>Named Signatures ({signatures.filter((s) => s.accountId === activeSigAccount.id).length})</strong>
                    {signatures
                      .filter((s) => s.accountId === activeSigAccount.id)
                      .map((sig) => (
                        <div key={sig.id} style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <div>
                            <strong>{sig.name}</strong> {sig.isDefault && <span className="chip" style={{ height: 18, fontSize: 10 }}>Default</span>}
                            <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{sig.bodyText || '(HTML signature)'}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {!sig.isDefault && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={async () => {
                                  await apiRequest(`/workspace/signatures/${sig.id}`, { method: 'PATCH', body: { isDefault: true } });
                                  await loadDiagnostics();
                                  await props.onRefreshAll();
                                }}
                              >
                                Make Default
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon"
                              onClick={async () => {
                                await apiRequest(`/workspace/signatures/${sig.id}`, { method: 'DELETE' });
                                await loadDiagnostics();
                              }}
                              aria-label={`Delete signature ${sig.name}`}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input className="field" style={{ width: 170 }} placeholder="Signature name..." value={newSigName} onChange={(e) => setNewSigName(e.target.value)} />
                      <input className="field" style={{ flex: 1, minWidth: 200 }} placeholder="HTML or plain text signature..." value={newSigHtml} onChange={(e) => setNewSigHtml(e.target.value)} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input type="checkbox" checked={newSigDefault} onChange={(e) => setNewSigDefault(e.target.checked)} /> Default
                      </label>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          if (!newSigName.trim()) return;
                          await apiRequest('/workspace/signatures', {
                            method: 'POST',
                            body: { accountId: activeSigAccount.id, name: newSigName.trim(), bodyHtml: newSigHtml || `<p>${newSigName.trim()}</p>`, isDefault: newSigDefault },
                          });
                          setNewSigName('');
                          setNewSigHtml('');
                          setNewSigDefault(false);
                          await loadDiagnostics();
                          await props.onRefreshAll();
                        }}
                      >
                        <Plus size={12} /> Add Signature
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === 'notifications' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Notifications & Quiet Hours</h2>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.notifications.enabled}
                  onChange={(e) => void props.onUpdatePreferences({ notifications: { enabled: e.target.checked } })}
                />
                Enable new-mail notifications
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.notifications.importantOnly}
                  onChange={(e) => void props.onUpdatePreferences({ notifications: { importantOnly: e.target.checked } })}
                />
                Notify only for Important / Priority messages
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.notifications.quietHoursEnabled}
                  onChange={(e) => void props.onUpdatePreferences({ notifications: { quietHoursEnabled: e.target.checked } })}
                />
                Enable Quiet Hours
              </label>
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  type="time"
                  className="field"
                  style={{ width: 130 }}
                  value={preferences.notifications.quietHoursStart}
                  onChange={(e) => void props.onUpdatePreferences({ notifications: { quietHoursStart: e.target.value } })}
                />
                <span style={{ alignSelf: 'center', color: 'var(--text-muted)' }}>to</span>
                <input
                  type="time"
                  className="field"
                  style={{ width: 130 }}
                  value={preferences.notifications.quietHoursEnd}
                  onChange={(e) => void props.onUpdatePreferences({ notifications: { quietHoursEnd: e.target.value } })}
                />
              </div>
              {'Notification' in window && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => void Notification.requestPermission()}
                >
                  Browser Permission Status: {Notification.permission}
                </button>
              )}
            </section>
          )}

          {tab === 'ai' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>AI Intelligence & Privacy Controls</h2>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.ai.enabled && preferences.ai.privacyDisclosureAccepted}
                  onChange={(e) =>
                    void props.onUpdatePreferences({
                      ai: { enabled: e.target.checked, privacyDisclosureAccepted: e.target.checked },
                    })
                  }
                />
                Enable AI Assistant (writing, smart replies, summarization, task extraction, translation)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={preferences.ai.redactSensitiveContent}
                  onChange={(e) => void props.onUpdatePreferences({ ai: { redactSensitiveContent: e.target.checked } })}
                />
                Automatically redact card numbers, SSNs, API keys, and passwords before AI requests
              </label>
              <div style={{ padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5 }}>
                <strong>Server AI Integration Status:</strong>{' '}
                {aiStatus?.provider?.configured ? (
                  <span style={{ color: 'var(--status-success)' }}>
                    Configured ({aiStatus.provider.activeProvider} / {aiStatus.provider.model})
                  </span>
                ) : (
                  <div>
                    <span style={{ color: 'var(--status-warning)' }}>Not configured on server</span>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                      {(aiStatus?.provider?.setupInstructions || []).map((s: string, i: number) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === 'accounts' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Connected Accounts & Security</h2>

              {/* Connected Accounts List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {props.accounts.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      padding: 12,
                      borderRadius: 'var(--radius-lg)',
                      border: '1px solid var(--border-hairline)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span>{a.displayName} ({a.emailAddress})</span>
                          <span className="chip" style={{ fontSize: 10.5 }}>
                            {a.accountOwnership === 'hosted' || a.providerType === 'hosted' || a.providerType === 'local'
                              ? 'Platform-Hosted'
                              : `External · ${a.providerType}`}
                          </span>
                          {a.isDefault && <span className="chip" style={{ fontSize: 10.5, background: 'var(--accent-soft)', color: 'var(--accent)' }}>Default</span>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                          Status: <strong>{a.status}</strong>
                          {a.lastSyncedAt && ` · Last sync: ${new Date(a.lastSyncedAt).toLocaleTimeString()}`}
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                          {a.capabilities?.supportsFolders && <span className="chip" style={{ height: 18, fontSize: 10 }}>Folders</span>}
                          {a.capabilities?.supportsLabels && <span className="chip" style={{ height: 18, fontSize: 10 }}>Native Labels</span>}
                          {a.capabilities?.supportsRemoteSearch && <span className="chip" style={{ height: 18, fontSize: 10 }}>Remote Search</span>}
                          {a.capabilities?.supportsDkim && <span className="chip" style={{ height: 18, fontSize: 10 }}>DKIM</span>}
                        </div>
                        {a.lastError && <div style={{ fontSize: 12, color: 'var(--status-danger)' }}>{a.lastError}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {!a.isDefault && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              await apiRequest(`/accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } });
                              await props.onRefreshAll();
                            }}
                          >
                            Set Default
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            if (openSyncLogAcctId === a.id) {
                              setOpenSyncLogAcctId(null);
                              return;
                            }
                            const res = await apiRequest<{ logs: any[] }>(`/accounts/${a.id}/sync-logs`);
                            setSyncLogs(res.logs || []);
                            setOpenSyncLogAcctId(a.id);
                          }}
                        >
                          Sync Logs
                        </button>
                        {(a.providerType === 'imap_smtp' || a.providerType === 'yahoo') && (
                          <button
                            type="button"
                            className={`btn btn-sm ${a.status === 'auth_expired' || a.status === 'error' ? 'btn-primary' : ''}`}
                            onClick={() => {
                              if (updatingCredAcctId === a.id) {
                                setUpdatingCredAcctId(null);
                                return;
                              }
                              setUpdatingCredAcctId(a.id);
                              setUpdPassword('');
                              setUpdUsername('');
                              setUpdImapHost('');
                              setUpdImapPort('');
                              setUpdSmtpHost('');
                              setUpdSmtpPort('');
                            }}
                          >
                            <KeyRound size={12} /> {a.status === 'auth_expired' || a.status === 'error' ? 'Reconnect / Update Password' : 'Update Credentials'}
                          </button>
                        )}
                        {(a.providerType === 'gmail' || a.providerType === 'outlook') && (
                          <button
                            type="button"
                            className={`btn btn-sm ${a.status === 'auth_expired' || a.status === 'error' ? 'btn-primary' : ''}`}
                            onClick={async () => {
                              try {
                                const res = await apiRequest<{ authUrl: string }>(`/accounts/oauth/${a.providerType}/start`);
                                window.location.href = res.authUrl;
                              } catch (err) {
                                setBanner({
                                  type: 'err',
                                  text: err instanceof ApiError ? err.message : 'Unable to start OAuth2 re-authorization.',
                                });
                              }
                            }}
                          >
                            <ExternalLink size={12} /> Re-authorize OAuth2
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            await apiRequest(`/accounts/${a.id}/sync`, { method: 'POST' });
                            await props.onRefreshAll();
                          }}
                        >
                          <RefreshCw size={12} /> Sync
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={async () => {
                            await apiRequest(`/accounts/${a.id}`, { method: 'DELETE' });
                            await props.onRefreshAll();
                          }}
                          title="Disconnect account"
                          aria-label={`Disconnect ${a.emailAddress}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {updatingCredAcctId === a.id && (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const body: Record<string, string | number> = {};
                          if (updPassword) body.password = updPassword;
                          if (updUsername.trim()) body.username = updUsername.trim();
                          if (updImapHost.trim()) body.imapHost = updImapHost.trim();
                          if (updImapPort.trim()) body.imapPort = Number(updImapPort.trim());
                          if (updSmtpHost.trim()) body.smtpHost = updSmtpHost.trim();
                          if (updSmtpPort.trim()) body.smtpPort = Number(updSmtpPort.trim());
                          if (Object.keys(body).length === 0) {
                            setBanner({ type: 'err', text: 'Enter a new App Password or server setting to update.' });
                            return;
                          }
                          setCredBusy(true);
                          setBanner(null);
                          try {
                            await apiRequest(`/accounts/${a.id}/credentials`, { method: 'PATCH', body });
                            setUpdatingCredAcctId(null);
                            setUpdPassword('');
                            await props.onRefreshAll();
                            setBanner({ type: 'ok', text: `Verified credentials and reconnected ${a.emailAddress}.` });
                          } catch (err) {
                            setBanner({
                              type: 'err',
                              text: err instanceof ApiError ? err.message : 'Credential verification failed.',
                            });
                          } finally {
                            setCredBusy(false);
                          }
                        }}
                        style={{
                          padding: 12,
                          borderRadius: 'var(--radius-md)',
                          background: 'var(--bg-subtle)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          fontSize: 12,
                        }}
                      >
                        <strong>Update Credentials &amp; Reconnect ({a.emailAddress})</strong>
                        <span style={{ color: 'var(--text-muted)' }}>
                          Paste a new App Password / mailbox password (optional server fields override existing host settings while keeping all local labels and history).
                        </span>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 8 }}>
                          <input
                            type="password"
                            className="field"
                            placeholder="New App Password / Password"
                            value={updPassword}
                            onChange={(e) => setUpdPassword(e.target.value)}
                          />
                          <input
                            className="field"
                            placeholder="Login Username (optional)"
                            value={updUsername}
                            onChange={(e) => setUpdUsername(e.target.value)}
                          />
                          <input
                            className="field"
                            placeholder="IMAP Host (optional)"
                            value={updImapHost}
                            onChange={(e) => setUpdImapHost(e.target.value)}
                          />
                          <input
                            type="number"
                            className="field"
                            placeholder="IMAP Port"
                            value={updImapPort}
                            onChange={(e) => setUpdImapPort(e.target.value)}
                          />
                          <input
                            className="field"
                            placeholder="SMTP Host (optional)"
                            value={updSmtpHost}
                            onChange={(e) => setUpdSmtpHost(e.target.value)}
                          />
                          <input
                            type="number"
                            className="field"
                            placeholder="SMTP Port"
                            value={updSmtpPort}
                            onChange={(e) => setUpdSmtpPort(e.target.value)}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="submit" className="btn btn-sm btn-primary" disabled={credBusy}>
                            {credBusy ? 'Verifying...' : 'Verify & Reconnect'}
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setUpdatingCredAcctId(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}

                    {openSyncLogAcctId === a.id && (
                      <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12 }}>
                        <strong style={{ display: 'block', marginBottom: 6 }}>Recent Synchronization History</strong>
                        {syncLogs.length === 0 ? (
                          <span style={{ color: 'var(--text-muted)' }}>No synchronization events recorded yet.</span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {syncLogs.slice(0, 6).map((lg) => (
                              <div key={lg.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                                <span>
                                  <strong>{lg.status}</strong> · +{lg.messages_added} / ~{lg.messages_updated} ({lg.duration_ms} ms)
                                  {lg.error_message ? ` — ${lg.error_message}` : ''}
                                </span>
                                <span className="tabular" style={{ color: 'var(--text-muted)' }}>
                                  {new Date(lg.created_at).toLocaleString()}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Connect Real Email Provider */}
              <div style={{ padding: 16, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <strong style={{ fontSize: 14 }}>Connect Real Email Provider</strong>
                <ConnectRealMailPanel
                  defaultName={props.accounts[0]?.displayName || ''}
                  onConnected={async () => {
                    await props.onRefreshAll();
                    await loadDiagnostics();
                  }}
                />

                {/* Optional Local Offline Sandbox Mailbox (collapsed by default) */}
                <details style={{ paddingTop: 10, borderTop: '1px solid var(--border-hairline)' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
                    Developer / Offline Testing: Add Local Sandbox Mailbox
                  </summary>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await apiRequest('/accounts/local', {
                          method: 'POST',
                          body: { emailAddress: localEmail, displayName: localName, seedStarter: localSeed },
                        });
                        setLocalEmail('');
                        setLocalName('');
                        await props.onRefreshAll();
                        setBanner({ type: 'ok', text: 'Local sandbox mailbox added.' });
                      } catch (err: any) {
                        setBanner({ type: 'err', text: err.message });
                      }
                    }}
                    style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 10 }}
                  >
                    <input className="field" style={{ flex: 1, minWidth: 160 }} placeholder="Display Name" value={localName} onChange={(e) => setLocalName(e.target.value)} required />
                    <input type="email" className="field" style={{ flex: 1, minWidth: 180 }} placeholder="sandbox@cadence.local" value={localEmail} onChange={(e) => setLocalEmail(e.target.value)} required />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                      <input type="checkbox" checked={localSeed} onChange={(e) => setLocalSeed(e.target.checked)} /> Seed sample
                    </label>
                    <button type="submit" className="btn btn-sm"><Plus size={13} /> Add Local Mailbox</button>
                  </form>
                </details>
              </div>

              {/* Security & Privacy Center Dashboard */}
              {securityCenter && (
                <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <strong style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Shield size={15} color="var(--accent)" /> Security &amp; Privacy Center
                  </strong>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                    {securityCenter.posture.map((p) => (
                      <div key={p.id} style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <strong>{p.label}</strong>
                          <span className="chip" style={{ height: 18, fontSize: 10, color: p.status === 'ok' ? 'var(--status-success)' : 'var(--status-warning)' }}>{p.status}</span>
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>{p.detail}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 12.5, display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-secondary)' }}>
                    <span>Total Mail Storage: <strong className="tabular">{formatBytes(securityCenter.storage.totalBytes)}</strong></span>
                    <span>Attachments Storage: <strong className="tabular">{formatBytes(securityCenter.storage.attachmentsBytes)}</strong></span>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      Trash Retention (days):
                      <input
                        type="number"
                        min={1}
                        max={365}
                        className="field"
                        style={{ width: 68, height: 24, fontSize: 12 }}
                        value={preferences.retention?.trashRetentionDays ?? 30}
                        onChange={(e) => void props.onUpdatePreferences({ retention: { trashRetentionDays: Number(e.target.value) || 30 } })}
                      />
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      Spam Retention (days):
                      <input
                        type="number"
                        min={1}
                        max={365}
                        className="field"
                        style={{ width: 68, height: 24, fontSize: 12 }}
                        value={preferences.retention?.spamRetentionDays ?? 30}
                        onChange={(e) => void props.onUpdatePreferences({ retention: { spamRetentionDays: Number(e.target.value) || 30 } })}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ height: 24, fontSize: 11.5 }}
                      onClick={async () => {
                        const res = await apiRequest<{ deletedMessages: number }>('/threads/retention/purge', { method: 'POST' });
                        setBanner({
                          type: 'ok',
                          text:
                            res.deletedMessages > 0
                              ? `Purged ${res.deletedMessages} expired Trash/Spam message(s).`
                              : 'No expired Trash or Spam messages past your retention window.',
                        });
                        await loadDiagnostics();
                        await props.onRefreshAll();
                      }}
                    >
                      Purge Expired Now
                    </button>
                  </div>
                  {securityCenter.oauthPermissions.some((o) => o.scopes.length > 0) && (
                    <div style={{ fontSize: 12 }}>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Connected OAuth Permissions</strong>
                      {securityCenter.oauthPermissions
                        .filter((o) => o.scopes.length > 0)
                        .map((o) => (
                          <div key={o.accountId} style={{ padding: '4px 0', color: 'var(--text-muted)' }}>
                            <strong>{o.emailAddress}</strong> ({o.providerType}): {o.scopes.join(', ')}
                          </div>
                        ))}
                    </div>
                  )}
                  {securityCenter.loginHistory.length > 0 && (
                    <details>
                      <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
                        Recent Security &amp; Login Events ({securityCenter.loginHistory.length})
                      </summary>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, maxHeight: 160, overflowY: 'auto' }}>
                        {securityCenter.loginHistory.slice(0, 12).map((ev) => (
                          <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)' }}>
                            <span><strong>{ev.eventType}</strong> ({ev.severity}) {ev.ipAddress ? `· ${ev.ipAddress}` : ''}</span>
                            <span className="tabular">{new Date(ev.createdAt).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Active Sessions */}
              <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Shield size={14} /> Active Sessions ({sessions.length})
                  </strong>
                  {sessions.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await apiRequest('/auth/sessions', { method: 'DELETE' });
                        await loadDiagnostics();
                      }}
                    >
                      Revoke All Others
                    </button>
                  )}
                </div>
                {sessions.map((s) => (
                  <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12.5 }}>
                    <span>{s.userAgent?.slice(0, 60) || 'Session'} {s.isCurrent ? '(Current)' : ''}</span>
                    {!s.isCurrent && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await apiRequest(`/auth/sessions/${s.id}`, { method: 'DELETE' });
                          await loadDiagnostics();
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Blocked Senders */}
              {blockedSenders.length > 0 && (
                <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)' }}>
                  <strong style={{ fontSize: 13.5 }}>Blocked Senders</strong>
                  {blockedSenders.map((b) => (
                    <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', fontSize: 12.5 }}>
                      <span>{b.email_or_domain}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await apiRequest(`/org/blocked-senders/${b.id}`, { method: 'DELETE' });
                          await loadDiagnostics();
                        }}
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Data Export & Account Deletion */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <a href="/api/v1/auth/export" download="cadence-data-export.json" className="btn">
                  <Download size={14} /> Export Workspace Data (JSON)
                </a>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setConfirmDeleteAccount(true)}
                >
                  <Trash2 size={14} /> Delete Account & Data
                </button>
              </div>

              {confirmDeleteAccount && (
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label="Confirm permanent account deletion"
                  style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.55)',
                    zIndex: 95,
                    display: 'grid',
                    placeItems: 'center',
                    padding: 20,
                  }}
                  onClick={() => setConfirmDeleteAccount(false)}
                >
                  <div
                    style={{
                      width: '100%',
                      maxWidth: 420,
                      background: 'var(--bg-elevated)',
                      borderRadius: 'var(--radius-xl)',
                      padding: 22,
                      border: '1px solid var(--border-strong)',
                      boxShadow: 'var(--shadow-lg)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <strong style={{ fontSize: 15.5, color: 'var(--status-danger)' }}>
                      Permanently delete your account &amp; all data?
                    </strong>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      This removes your Cadence user profile, connected mailboxes, local correspondence, drafts, rules, and attachments permanently. Export a JSON backup first if needed.
                    </p>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button type="button" className="btn" onClick={() => setConfirmDeleteAccount(false)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={async () => {
                          setConfirmDeleteAccount(false);
                          await apiRequest('/auth/account', { method: 'DELETE' });
                          await props.onLogout();
                        }}
                      >
                        Permanently Delete Account
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
