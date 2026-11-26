import React, { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Database,
  Globe,
  HardDriveDownload,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Shield,
  ShieldAlert,
  Trash2,
  Users,
} from 'lucide-react';
import { ApiError, apiRequest } from '../api/client';
import { formatBytes } from './CadenceMark';

type AdminTab = 'overview' | 'domains' | 'users' | 'queue' | 'security';

export function AdminConsoleView({ onRefreshAccounts }: { onRefreshAccounts: () => Promise<void> }) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [overview, setOverview] = useState<any>(null);
  const [domains, setDomains] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [deliveryLogs, setDeliveryLogs] = useState<any[]>([]);
  const [securityEvents, setSecurityEvents] = useState<any[]>([]);
  const [backups, setBackups] = useState<any[]>([]);
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Domain create form
  const [newDomain, setNewDomain] = useState('');
  const [newMxHost, setNewMxHost] = useState('');
  const [activateInternal, setActivateInternal] = useState(false);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);

  // User create form
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPass, setNewUserPass] = useState('');
  const [newUserDomainId, setNewUserDomainId] = useState('');
  const [newUserQuotaMb, setNewUserQuotaMb] = useState(1024);

  // Alias create state
  const [aliasTargetAcctId, setAliasTargetAcctId] = useState('');
  const [aliasAddress, setAliasAddress] = useState('');

  async function loadAll() {
    setBusy(true);
    try {
      const [ov, dom, usr, q, logs, sec, bak] = await Promise.all([
        apiRequest<any>('/admin/overview'),
        apiRequest<{ domains: any[] }>('/admin/domains'),
        apiRequest<{ users: any[] }>('/admin/users'),
        apiRequest<{ queue: any[] }>('/admin/queue'),
        apiRequest<{ logs: any[] }>('/admin/delivery-logs'),
        apiRequest<{ events: any[] }>('/admin/security-events'),
        apiRequest<{ backups: any[] }>('/admin/backups'),
      ]);
      setOverview(ov);
      setDomains(dom.domains);
      setUsers(usr.users);
      setQueue(q.queue);
      setDeliveryLogs(logs.logs);
      setSecurityEvents(sec.events);
      setBackups(bak.backups);
      if (!newUserDomainId && dom.domains.length > 0) {
        setNewUserDomainId(dom.domains[0].id);
      }
    } catch (err) {
      setBanner({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to load administration console' });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  const tabs: Array<{ id: AdminTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview & Health', icon: <Activity size={14} /> },
    { id: 'domains', label: 'Domains & DNS', icon: <Globe size={14} /> },
    { id: 'users', label: 'Users, Mailboxes & Aliases', icon: <Users size={14} /> },
    { id: 'queue', label: 'Mail Queue & Logs', icon: <Server size={14} /> },
    { id: 'security', label: 'Security & Backups', icon: <Shield size={14} /> },
  ];

  return (
    <div className="cadence-subview-shell">
      <div className="cadence-subview-nav">
        <strong style={{ fontSize: 13.5, padding: '4px 10px 8px' }}>Infrastructure Admin</strong>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
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
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
        <div style={{ marginTop: 'auto', paddingTop: 10 }}>
          <button type="button" className="btn btn-sm" style={{ width: '100%' }} onClick={() => void loadAll()} disabled={busy}>
            <RefreshCw size={12} /> Refresh Stats
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {banner && (
            <div
              role={banner.type === 'err' ? 'alert' : 'status'}
              style={{
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                background: banner.type === 'ok' ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
                color: banner.type === 'ok' ? 'var(--status-success)' : 'var(--status-danger)',
                fontSize: 13,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>{banner.text}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBanner(null)}>Dismiss</button>
            </div>
          )}

          {tab === 'overview' && overview && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Independent Mail Service Health &amp; Telemetry</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
                {[
                  { label: 'Users (Active / Suspended)', val: `${overview.users.active} / ${overview.users.suspended}` },
                  { label: 'Domains (Active / DNS Verified)', val: `${overview.domains.active} / ${overview.domains.dnsVerified}` },
                  { label: 'Mailboxes (Hosted / External)', val: `${overview.mailboxes.hosted} / ${overview.mailboxes.external}` },
                  { label: 'Aliases Configured', val: `${overview.mailboxes.aliases}` },
                  { label: 'Inbound (Delivered / Spam)', val: `${overview.traffic.inboundDelivered} / ${overview.traffic.inboundSpamQuarantined}` },
                  { label: 'Outbound (Delivered / Failed)', val: `${overview.traffic.outboundDelivered} / ${overview.traffic.outboundFailed}` },
                  { label: 'Queue (Queued / Retry / MX OK)', val: `${overview.queue.queued} / ${overview.queue.retryPending} / ${overview.queue.acceptedMx}` },
                  { label: 'Mailbox / DB Storage', val: `${formatBytes(overview.mailboxes.storageBytes)} / ${formatBytes(overview.mailboxes.dbSizeBytes)}` },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    style={{
                      padding: 14,
                      borderRadius: 'var(--radius-lg)',
                      border: '1px solid var(--border-hairline)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>{stat.label}</div>
                    <div className="tabular" style={{ fontSize: 18, fontWeight: 700 }}>{stat.val}</div>
                  </div>
                ))}
              </div>

              {/* SMTP Listeners Status */}
              <div style={{ padding: 16, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)' }}>
                <strong style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <Server size={15} /> Native SMTP Infrastructure Status
                </strong>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, fontSize: 12.5 }}>
                  <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                    <div><strong>Incoming MX Listener:</strong> {overview.smtp.mx.listening ? 'Listening' : 'Offline'}</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      Bind: <code>{overview.smtp.mx.host}:{overview.smtp.mx.port}</code> · TLS: {overview.smtp.mx.tls ? 'Configured' : 'Plaintext/Local'}
                    </div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                    <div><strong>Authenticated Submission:</strong> {overview.smtp.submission.listening ? 'Listening' : 'Offline'}</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      Bind: <code>{overview.smtp.submission.host}:{overview.smtp.submission.port}</code> · Outbound Relay: {overview.smtp.outboundRelayConfigured ? 'Relay Active' : 'Direct MX'}
                    </div>
                  </div>
                </div>
                {overview.smtp.warnings?.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--status-warning)' }}>
                    Warnings: {overview.smtp.warnings.join('; ')}
                  </div>
                )}
              </div>

              {overview.observability && (
                <div style={{ padding: 16, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)' }}>
                  <strong style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <Activity size={15} /> Application Observability &amp; API Telemetry
                  </strong>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, fontSize: 12.5 }}>
                    <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>API Requests / Errors</div>
                      <strong className="tabular">{overview.observability.totalRequests} reqs · {overview.observability.serverErrors5xx} (5xx)</strong>
                    </div>
                    <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Latency (Avg / p95)</div>
                      <strong className="tabular">{overview.observability.avgLatencyMs}ms / {overview.observability.p95LatencyMs}ms</strong>
                    </div>
                    <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Memory (RSS / Heap)</div>
                      <strong className="tabular">{overview.observability.memoryRssMb} MB / {overview.observability.heapUsedMb} MB</strong>
                    </div>
                    <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>SSE Streams / Uptime</div>
                      <strong className="tabular">{overview.observability.activeSseClients} active · {overview.observability.uptimeSeconds}s</strong>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === 'domains' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Hosted Email Domains &amp; DNS Verification Assistant</h2>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const res = await apiRequest<{ domain: any }>('/admin/domains', {
                      method: 'POST',
                      body: {
                        domain: newDomain,
                        primaryMxHost: newMxHost || undefined,
                        activateInternal,
                      },
                    });
                    setNewDomain('');
                    setNewMxHost('');
                    setExpandedDomainId(res.domain.id);
                    setBanner({ type: 'ok', text: `Registered domain ${res.domain.domain} with 2048-bit RSA DKIM keys.` });
                    await loadAll();
                  } catch (err: any) {
                    setBanner({ type: 'err', text: err.message });
                  }
                }}
                style={{
                  padding: 14,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-hairline)',
                  background: 'var(--bg-elevated)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <strong style={{ fontSize: 13.5 }}>Add Configurable Email Domain</strong>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input className="field" style={{ flex: 1, minWidth: 200 }} placeholder="yourdomain.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} required />
                  <input className="field" style={{ flex: 1, minWidth: 200 }} placeholder="Primary MX host (optional, e.g. mail.yourdomain.com)" value={newMxHost} onChange={(e) => setNewMxHost(e.target.value)} />
                  <button type="submit" className="btn btn-primary btn-sm"><Plus size={13} /> Add Domain</button>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={activateInternal} onChange={(e) => setActivateInternal(e.target.checked)} />
                  Activate immediately as an Internal/Private domain without requiring public DNS TXT verification first
                </label>
              </form>

              {domains.length === 0 ? (
                <div style={{ padding: 24, borderRadius: 'var(--radius-lg)', border: '1px dashed var(--border-strong)', color: 'var(--text-muted)', textAlign: 'center', fontSize: 13 }}>
                  No hosted domains configured yet. Add your own domain above to host mailboxes with DKIM, SPF, DMARC, and native MX delivery.
                </div>
              ) : (
                domains.map((dom) => (
                  <div key={dom.id} style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 14.5 }}>{dom.domain}</strong>
                          <span className="chip" style={{
                            background: dom.ownershipVerified ? 'var(--status-success-bg)' : dom.status === 'active' ? 'var(--status-info-bg)' : 'var(--status-warning-bg)',
                            color: dom.ownershipVerified ? 'var(--status-success)' : dom.status === 'active' ? 'var(--status-info)' : 'var(--status-warning)',
                          }}>
                            {dom.ownershipVerified ? 'Live DNS Verified' : dom.internalOnly && dom.status === 'active' ? 'Active (Internal Mode)' : dom.status}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                          MX: <code>{dom.primaryMxHost}</code> · DKIM selector: <code>{dom.dkimSelector}</code> · Mailboxes: {dom.mailboxCount} · Aliases: {dom.aliasCount}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={async () => {
                            const res = await apiRequest<{ domain: any }>(`/admin/domains/${dom.id}/verify-dns`, { method: 'POST' });
                            setExpandedDomainId(dom.id);
                            setBanner({
                              type: res.domain.ownershipVerified ? 'ok' : 'err',
                              text: res.domain.ownershipVerified
                                ? `Live DNS verified ownership for ${dom.domain}!`
                                : `Live DNS check ran for ${dom.domain}; some records are missing or unreachable.`,
                            });
                            await loadAll();
                          }}
                        >
                          <CheckCircle2 size={13} /> Verify Live DNS
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setExpandedDomainId((prev) => (prev === dom.id ? null : dom.id))}
                        >
                          {expandedDomainId === dom.id ? 'Hide DNS Assistant' : 'DNS Assistant'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            await apiRequest(`/admin/domains/${dom.id}/rotate-dkim`, { method: 'POST' });
                            setBanner({ type: 'ok', text: `Rotated 2048-bit RSA DKIM keys for ${dom.domain}. Update your DKIM TXT record.` });
                            await loadAll();
                          }}
                        >
                          <KeyRound size={12} /> Rotate DKIM
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            const nextStatus = dom.status === 'active' ? 'disabled' : 'active';
                            await apiRequest(`/admin/domains/${dom.id}`, {
                              method: 'PATCH',
                              body: { status: nextStatus, internalOnly: nextStatus === 'active' && !dom.ownershipVerified },
                            });
                            await loadAll();
                          }}
                        >
                          {dom.status === 'active' ? 'Disable' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={async () => {
                            await apiRequest(`/admin/domains/${dom.id}`, { method: 'DELETE' });
                            await loadAll();
                          }}
                          aria-label={`Delete domain ${dom.domain}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {expandedDomainId === dom.id && (
                      <div style={{ paddingTop: 10, borderTop: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <strong style={{ fontSize: 12.5 }}>Required DNS Records ({dom.domain})</strong>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                            <thead>
                              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-hairline)' }}>
                                <th style={{ padding: '6px 8px' }}>Type</th>
                                <th style={{ padding: '6px 8px' }}>Host</th>
                                <th style={{ padding: '6px 8px' }}>Expected Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {dom.expectedRecords.map((rec: any, idx: number) => (
                                <tr key={idx} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{rec.recordType}</td>
                                  <td style={{ padding: '6px 8px' }}><code>{rec.host}</code></td>
                                  <td style={{ padding: '6px 8px', wordBreak: 'break-all' }}><code>{rec.value}</code></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {dom.dnsChecks?.length > 0 && (
                          <>
                            <strong style={{ fontSize: 12.5 }}>
                              Live DNS Audit ({dom.lastDnsCheckAt ? new Date(dom.lastDnsCheckAt).toLocaleString() : 'Not checked'})
                            </strong>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {dom.dnsChecks.map((chk: any) => (
                                <div key={chk.recordType} style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span><strong>{chk.label}</strong> (<code>{chk.host}</code>)</span>
                                    <span className="chip" style={{
                                      color: chk.status === 'verified' ? 'var(--status-success)' : 'var(--status-warning)',
                                    }}>
                                      {chk.status}
                                    </span>
                                  </div>
                                  <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{chk.recommendedAction}</div>
                                  {chk.actualValues?.length > 0 && (
                                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>Found: <code>{chk.actualValues.join(' | ')}</code></div>
                                  )}
                                  {chk.error && <div style={{ color: 'var(--status-danger)', marginTop: 2 }}>{chk.error}</div>}
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </section>
          )}

          {tab === 'users' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>User Accounts, Hosted Mailboxes &amp; Aliases</h2>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await apiRequest('/admin/users', {
                      method: 'POST',
                      body: {
                        name: newUserName,
                        email: newUserEmail,
                        password: newUserPass,
                        domainId: newUserDomainId || undefined,
                        mailboxAddress: newUserEmail,
                        quotaMb: newUserQuotaMb,
                      },
                    });
                    setNewUserName('');
                    setNewUserEmail('');
                    setNewUserPass('');
                    setBanner({ type: 'ok', text: 'Created platform user & hosted mailbox.' });
                    await loadAll();
                    await onRefreshAccounts();
                  } catch (err: any) {
                    setBanner({ type: 'err', text: err.message });
                  }
                }}
                style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <strong style={{ fontSize: 13.5 }}>Create Hosted User &amp; Mailbox</strong>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                  <input className="field" placeholder="Full Name" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} required />
                  <input type="email" className="field" placeholder="user@yourdomain.com" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} required />
                  <input type="password" className="field" minLength={8} placeholder="Password (8+ chars)" value={newUserPass} onChange={(e) => setNewUserPass(e.target.value)} required />
                  <input type="number" className="field" min={10} value={newUserQuotaMb} onChange={(e) => setNewUserQuotaMb(Number(e.target.value))} title="Quota MB" />
                  <select className="field" value={newUserDomainId} onChange={(e) => setNewUserDomainId(e.target.value)}>
                    <option value="">No linked domain</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.id}>{d.domain}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <button type="submit" className="btn btn-primary btn-sm"><Plus size={13} /> Provision User &amp; Mailbox</button>
                </div>
              </form>

              {users.map((u) => (
                <div key={u.id} style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {u.name} ({u.email}) · <span className="chip">{u.role}</span> · <span className="chip">{u.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        Quota: {u.quotaMb} MB · Hosted Mailboxes: {u.hostedMailboxes.length} · External Connected Accounts (private): {u.externalAccountCount}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await apiRequest(`/admin/users/${u.id}`, {
                            method: 'PATCH',
                            body: { status: u.status === 'active' ? 'suspended' : 'active' },
                          });
                          await loadAll();
                        }}
                      >
                        {u.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await apiRequest(`/admin/users/${u.id}`, {
                            method: 'PATCH',
                            body: { role: u.role === 'admin' ? 'member' : 'admin' },
                          });
                          await loadAll();
                        }}
                      >
                        Toggle Role
                      </button>
                    </div>
                  </div>

                  {u.hostedMailboxes.map((mb: any) => (
                    <div key={mb.id} style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <span>
                        <strong>{mb.email_address}</strong> ({mb.provider_type}) · {formatBytes(mb.used_bytes)} / {mb.quota_mb} MB
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setAliasTargetAcctId(mb.id)}
                        >
                          + Add Alias
                        </button>
                      </div>
                    </div>
                  ))}

                  {u.aliases.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Aliases:</span>
                      {u.aliases.map((al: any) => (
                        <span key={al.id} className="chip" style={{ gap: 6 }}>
                          {al.alias_address}
                          <button
                            type="button"
                            style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'inherit' }}
                            onClick={async () => {
                              await apiRequest(`/admin/aliases/${al.id}`, { method: 'DELETE' });
                              await loadAll();
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {aliasTargetAcctId && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await apiRequest('/admin/aliases', {
                        method: 'POST',
                        body: { accountId: aliasTargetAcctId, aliasAddress },
                      });
                      setAliasAddress('');
                      setAliasTargetAcctId('');
                      await loadAll();
                    } catch (err: any) {
                      setBanner({ type: 'err', text: err.message });
                    }
                  }}
                  style={{ padding: 12, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-elevated)', display: 'flex', gap: 8, alignItems: 'center' }}
                >
                  <input type="email" className="field" placeholder="support@yourdomain.com" value={aliasAddress} onChange={(e) => setAliasAddress(e.target.value)} required />
                  <button type="submit" className="btn btn-primary btn-sm">Save Alias</button>
                  <button type="button" className="btn btn-sm" onClick={() => setAliasTargetAcctId('')}>Cancel</button>
                </form>
              )}
            </section>
          )}

          {tab === 'queue' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Outbound Mail Queue &amp; SMTP Delivery Logs</h2>

              <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)' }}>
                <strong style={{ fontSize: 13.5, display: 'block', marginBottom: 8 }}>Persistent Outbound Queue ({queue.length})</strong>
                {queue.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No queued external deliveries recorded yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {queue.map((q) => (
                      <div key={q.id} style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div>
                          <div><strong>{q.from_address}</strong> → {q.recipients_json} · <span className="chip">{q.status}</span> (attempts: {q.attempts}/{q.max_attempts})</div>
                          <div style={{ color: 'var(--text-muted)' }}>{q.subject} · {q.last_error || q.smtp_response}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          {(q.status === 'retry_pending' || q.status === 'failed' || q.status === 'bounced' || q.status === 'dead_letter') && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={async () => {
                                await apiRequest(`/admin/queue/${q.id}/retry`, { method: 'POST' });
                                await loadAll();
                              }}
                            >
                              <RotateCcw size={12} /> Retry
                            </button>
                          )}
                          {(q.status === 'queued' || q.status === 'retry_pending' || q.status === 'failed' || q.status === 'bounced') && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={async () => {
                                await apiRequest(`/admin/queue/${q.id}/dead-letter`, { method: 'POST' });
                                await loadAll();
                              }}
                            >
                              Dead-Letter
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            onClick={async () => {
                              await apiRequest(`/admin/queue/${q.id}`, { method: 'DELETE' });
                              await loadAll();
                            }}
                            aria-label="Delete queue entry"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)' }}>
                <strong style={{ fontSize: 13.5, display: 'block', marginBottom: 8 }}>Recent Inbound &amp; Outbound Delivery Logs ({deliveryLogs.length})</strong>
                {deliveryLogs.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No SMTP delivery logs yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {deliveryLogs.slice(0, 30).map((lg) => (
                      <div key={lg.id} style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span>
                            <span className="chip" style={{ marginRight: 6 }}>{lg.direction}</span>
                            <strong>{lg.from_address}</strong> → {lg.to_addresses_json} · <strong>{lg.status}</strong>
                          </span>
                          <span className="tabular" style={{ color: 'var(--text-muted)' }}>{new Date(lg.created_at).toLocaleString()}</span>
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                          {lg.mx_host ? `MX: ${lg.mx_host} · ` : ''}{lg.smtp_code ? `SMTP ${lg.smtp_code}: ` : ''}{lg.smtp_message}
                          {lg.dkim_signed ? ' · DKIM Signed' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === 'security' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Security Audit Events &amp; Infrastructure Backups</h2>

              {/* Backup & Recovery Card */}
              <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <strong style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Database size={15} /> Backup &amp; Recovery (Secrets Stripped)
                  </strong>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      await apiRequest('/admin/backups', { method: 'POST', body: { includeAttachments: true } });
                      setBanner({ type: 'ok', text: 'Verified point-in-time SQLite & attachments backup created.' });
                      await loadAll();
                    }}
                  >
                    <HardDriveDownload size={13} /> Create Backup Now
                  </button>
                </div>

                {backups.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No backups created yet.</div>
                ) : (
                  backups.map((b) => (
                    <div key={b.id} style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div><strong>{new Date(b.createdAt).toLocaleString()}</strong> · {formatBytes(b.sizeBytes)} · <span className="chip">{b.status}</span></div>
                        <div style={{ color: 'var(--text-muted)' }}>SHA-256: <code>{b.checksumSha256.slice(0, 20)}...</code> · Messages: {b.manifest?.counts?.messages ?? 0}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            const res = await apiRequest<any>(`/admin/backups/${b.id}/verify`, { method: 'POST' });
                            setBanner({
                              type: res.ok ? 'ok' : 'err',
                              text: res.ok
                                ? `Backup verified cleanly (SHA-256 matched, SQLite integrity: ${res.integrityResult}).`
                                : 'Backup integrity verification failed!',
                            });
                          }}
                        >
                          Verify Integrity
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            const res = await apiRequest<any>(`/admin/backups/${b.id}/restore`, {
                              method: 'POST',
                              body: { dryRun: true },
                            });
                            setBanner({ type: 'ok', text: `Dry-run restore passed: ${res.verified?.counts?.messages ?? 0} messages recoverable.` });
                          }}
                        >
                          Test Restore
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            await apiRequest(`/admin/backups/${b.id}/restore`, { method: 'POST', body: { dryRun: false } });
                            setBanner({ type: 'ok', text: 'Infrastructure & mailbox records restored from snapshot.' });
                            await loadAll();
                            await onRefreshAccounts();
                          }}
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Security Events Feed */}
              <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)' }}>
                <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <ShieldAlert size={14} /> Security &amp; Audit Events ({securityEvents.length})
                </strong>
                {securityEvents.slice(0, 40).map((ev) => (
                  <div key={ev.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-hairline)', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>
                      <span className="chip" style={{ marginRight: 6 }}>{ev.severity}</span>
                      <strong>{ev.event_type}</strong> {ev.actor_email ? `(${ev.actor_email})` : ''} {ev.ip_address ? `from ${ev.ip_address}` : ''}
                    </span>
                    <span className="tabular" style={{ color: 'var(--text-muted)' }}>{new Date(ev.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
