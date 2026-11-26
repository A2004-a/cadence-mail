import React, { useEffect, useState } from 'react';
import { Building2, Download, Edit2, Mail, Phone, Plus, Search, Star, Trash2, Users, X } from 'lucide-react';
import { apiRequest } from '../api/client';
import type { Contact } from '../types';
import { AvatarBadge } from './CadenceMark';

interface ContactsViewProps {
  onComposeTo: (email: string, name: string) => void;
}

export function ContactsView({ onComposeTo }: ContactsViewProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string; color: string; member_count: number }>>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importData, setImportData] = useState('');
  const [dupGroups, setDupGroups] = useState<Array<Array<{ id: string; name: string; email: string; organization: string }>> | null>(null);
  const [activityContact, setActivityContact] = useState<{
    contact: Contact;
    recentThreads: Array<{ id: string; subject: string; last_message_at: string; snippet: string }>;
    linkedTasks: Array<{ id: string; title: string; status: string; priority: string }>;
    linkedEvents: Array<{ id: string; title: string; start_at: string }>;
  } | null>(null);
  const [banner, setBanner] = useState('');

  async function load() {
    const [cRes, gRes] = await Promise.all([
      apiRequest<{ contacts: Contact[] }>(
        `/productivity/contacts?q=${encodeURIComponent(search)}${selectedGroupId ? `&groupId=${selectedGroupId}` : ''}`
      ),
      apiRequest<{ groups: Array<{ id: string; name: string; color: string; member_count: number }> }>('/productivity/contact-groups'),
    ]);
    setContacts(cRes.contacts);
    setGroups(gRes.groups);
  }

  useEffect(() => {
    void load();
  }, [search, selectedGroupId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editing?.name || !editing?.email) return;
    if (editing.id) {
      await apiRequest(`/productivity/contacts/${editing.id}`, {
        method: 'PATCH',
        body: { ...editing, groupIds: selectedGroupIds },
      });
    } else {
      await apiRequest('/productivity/contacts', {
        method: 'POST',
        body: { ...editing, groupIds: selectedGroupIds },
      });
    }
    setEditing(null);
    await load();
  }

  return (
    <div className="cadence-subview-shell">
      {/* Groups Sub-nav */}
      <div className="cadence-subview-nav">
        <strong style={{ fontSize: 13 }}>Contact Groups</strong>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ justifyContent: 'space-between', background: !selectedGroupId ? 'var(--accent-soft)' : 'transparent' }}
          onClick={() => setSelectedGroupId(null)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Users size={14} /> All Contacts</span>
          <span className="tabular">{contacts.length}</span>
        </button>
        {groups.map((g) => (
          <div key={g.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{
                flex: 1,
                justifyContent: 'space-between',
                background: selectedGroupId === g.id ? 'var(--accent-soft)' : 'transparent',
              }}
              onClick={() => setSelectedGroupId(g.id)}
            >
              <span>{g.name}</span>
              <span className="tabular">{g.member_count}</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              style={{ width: 24, height: 24 }}
              onClick={async () => {
                await apiRequest(`/productivity/contact-groups/${g.id}`, { method: 'DELETE' });
                if (selectedGroupId === g.id) setSelectedGroupId(null);
                await load();
              }}
              aria-label={`Delete group ${g.name}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newGroupName.trim()) return;
            await apiRequest('/productivity/contact-groups', { method: 'POST', body: { name: newGroupName.trim() } });
            setNewGroupName('');
            await load();
          }}
          style={{ display: 'flex', gap: 4, marginTop: 6 }}
        >
          <input
            className="field"
            style={{ height: 30, fontSize: 12 }}
            placeholder="New group..."
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" style={{ height: 30 }}>Add</button>
        </form>
      </div>

      {/* Main Directory */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-hairline)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 340 }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
            <input
              className="field"
              style={{ paddingLeft: 32, height: 34 }}
              placeholder="Search contacts by name, email, organization..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const res = await apiRequest<{ duplicateGroups: any[] }>('/productivity/contacts/duplicates');
                setDupGroups(res.duplicateGroups);
              }}
            >
              Find Duplicates
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setImportOpen(true)}>
              Import CSV / vCard
            </button>
            <a href="/api/v1/productivity/contacts/export?format=csv" download="cadence-contacts.csv" className="btn btn-sm">
              <Download size={13} /> CSV
            </a>
            <a href="/api/v1/productivity/contacts/export?format=vcf" download="cadence-contacts.vcf" className="btn btn-sm">
              <Download size={13} /> vCard
            </a>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setSelectedGroupIds([]);
                setEditing({ name: '', email: '', organization: '', phone: '', notes: '', customFields: {}, isFavorite: false, avatarColor: '#1D4ED8' });
              }}
            >
              <Plus size={14} /> Add Contact
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {banner && (
            <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--status-success-bg)', color: 'var(--status-success)', fontSize: 12.5 }}>
              {banner}
            </div>
          )}
          {editing && (
            <form
              onSubmit={handleSave}
              style={{
                marginBottom: 18,
                padding: 16,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-elevated)',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 10,
              }}
            >
              <input className="field" placeholder="Full Name *" value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
              <input type="email" className="field" placeholder="Email Address *" value={editing.email || ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} required />
              <input className="field" placeholder="Organization" value={editing.organization || ''} onChange={(e) => setEditing({ ...editing, organization: e.target.value })} />
              <input className="field" placeholder="Phone" value={editing.phone || ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
              <input
                className="field"
                placeholder="Role / Title (Custom Field)"
                value={editing.customFields?.role || ''}
                onChange={(e) => setEditing({ ...editing, customFields: { ...(editing.customFields || {}), role: e.target.value } })}
              />
              <input
                className="field"
                placeholder="Timezone / Handle (Custom Field)"
                value={editing.customFields?.timezone || ''}
                onChange={(e) => setEditing({ ...editing, customFields: { ...(editing.customFields || {}), timezone: e.target.value } })}
              />
              <textarea className="field" style={{ gridColumn: '1 / -1' }} rows={2} placeholder="Notes" value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                    <input type="checkbox" checked={Boolean(editing.isFavorite)} onChange={(e) => setEditing({ ...editing, isFavorite: e.target.checked })} />
                    Favorite
                  </label>
                  {groups.map((g) => (
                    <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={selectedGroupIds.includes(g.id)}
                        onChange={(e) =>
                          setSelectedGroupIds((prev) =>
                            e.target.checked ? [...prev, g.id] : prev.filter((id) => id !== g.id)
                          )
                        }
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Save Contact</button>
                </div>
              </div>
            </form>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
            {contacts.map((c) => (
              <div
                key={c.id}
                style={{
                  padding: 14,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-hairline)',
                  background: 'var(--bg-elevated)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <AvatarBadge name={c.name || c.email} color={c.avatarColor} size={36} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        {c.isFavorite && <Star size={12} fill="#F59E0B" color="#F59E0B" />}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.email}</div>
                      <div style={{ marginTop: 3 }}>
                        <span className="chip" style={{ height: 18, fontSize: 10 }}>
                          {c.source === 'provider_synced' ? 'Synced from Provider' : 'Local Contact'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 28, height: 28 }}
                      onClick={() => {
                        setSelectedGroupIds(c.groups.map((g) => g.id));
                        setEditing(c);
                      }}
                      title="Edit contact"
                      aria-label={`Edit ${c.name}`}
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 28, height: 28 }}
                      onClick={async () => {
                        await apiRequest(`/productivity/contacts/${c.id}`, { method: 'DELETE' });
                        await load();
                      }}
                      title="Delete contact"
                      aria-label={`Delete ${c.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {c.organization && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Building2 size={13} /> {c.organization}
                  </div>
                )}
                {c.phone && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Phone size={13} /> {c.phone}
                  </div>
                )}
                {c.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.notes}</div>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 6, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {c.groups.map((g) => (
                      <span key={g.id} className="chip" style={{ height: 20, fontSize: 10.5 }}>{g.name}</span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        const res = await apiRequest<{ recentThreads: any[]; linkedTasks: any[]; linkedEvents: any[] }>(
                          `/productivity/contacts/${c.id}/activity`
                        );
                        setActivityContact({ contact: c, ...res });
                      }}
                    >
                      History
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => onComposeTo(c.email, c.name)}>
                      <Mail size={12} /> Email
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {importOpen && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }} onClick={() => setImportOpen(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await apiRequest<{ imported: number; updated: number }>('/productivity/contacts/import', {
                method: 'POST',
                body: { data: importData },
              });
              setBanner(`Imported ${res.imported} contact(s), updated ${res.updated}.`);
              setImportData('');
              setImportOpen(false);
              await load();
            }}
            style={{ width: '100%', maxWidth: 480, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', padding: 20, border: '1px solid var(--border-strong)', display: 'flex', flexDirection: 'column', gap: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong>Import Contacts (CSV or vCard .vcf)</strong>
            <textarea className="field mono" rows={8} placeholder={"Name,Email,Organization,Phone\nJane Doe,jane@company.com,Acme,+1-555-0100"} value={importData} onChange={(e) => setImportData(e.target.value)} required />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setImportOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Import</button>
            </div>
          </form>
        </div>
      )}

      {dupGroups !== null && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }} onClick={() => setDupGroups(null)}>
          <div style={{ width: '100%', maxWidth: 480, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', padding: 20, border: '1px solid var(--border-strong)', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Duplicate Contact Detection</strong>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setDupGroups(null)}><X size={14} /></button>
            </div>
            {dupGroups.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No duplicate contact names detected.</div>
            ) : (
              dupGroups.map((grp, i) => (
                <div key={i} style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5 }}>
                  <div><strong>{grp[0].name}</strong> ({grp.length} entries)</div>
                  <div style={{ color: 'var(--text-muted)', margin: '4px 0' }}>{grp.map((g) => g.email).join(', ')}</div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      await apiRequest('/productivity/contacts/merge', {
                        method: 'POST',
                        body: { primaryId: grp[0].id, duplicateId: grp[1].id },
                      });
                      setDupGroups(null);
                      setBanner(`Merged duplicate contact entries for ${grp[0].name}.`);
                      await load();
                    }}
                  >
                    Merge First Two
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activityContact && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }} onClick={() => setActivityContact(null)}>
          <div style={{ width: '100%', maxWidth: 520, maxHeight: '80vh', overflowY: 'auto', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', padding: 20, border: '1px solid var(--border-strong)', display: 'flex', flexDirection: 'column', gap: 12 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Activity History: {activityContact.contact.name}</strong>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setActivityContact(null)}><X size={14} /></button>
            </div>
            <div>
              <strong style={{ fontSize: 12 }}>Linked Emails ({activityContact.recentThreads.length})</strong>
              {activityContact.recentThreads.map((t) => (
                <div key={t.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--border-hairline)' }}>
                  <strong>{t.subject}</strong>
                  <div style={{ color: 'var(--text-muted)' }}>{t.snippet}</div>
                </div>
              ))}
              {activityContact.recentThreads.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No linked correspondence yet.</div>}
            </div>
            <div>
              <strong style={{ fontSize: 12 }}>Linked Tasks ({activityContact.linkedTasks.length}) & Events ({activityContact.linkedEvents.length})</strong>
              {activityContact.linkedTasks.map((tk) => (
                <div key={tk.id} style={{ fontSize: 12, marginTop: 4 }}>Task: {tk.title} ({tk.status})</div>
              ))}
              {activityContact.linkedEvents.map((ev) => (
                <div key={ev.id} style={{ fontSize: 12, marginTop: 4 }}>Event: {ev.title} ({new Date(ev.start_at).toLocaleDateString()})</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
