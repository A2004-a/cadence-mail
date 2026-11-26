import React, { useEffect, useState } from 'react';
import { BellRing, Check, Edit2, FileText, Plus, Search, Trash2 } from 'lucide-react';
import { apiRequest } from '../api/client';
import type { Reminder, Template } from '../types';

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TemplatesView({
  templates,
  onReload,
}: {
  templates: Template[];
  onReload: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('Work');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filterQ, setFilterQ] = useState('');

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      name,
      subject,
      bodyHtml: `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
      category,
    };
    if (editingId) {
      await apiRequest(`/productivity/templates/${editingId}`, { method: 'PATCH', body: payload });
    } else {
      await apiRequest('/productivity/templates', { method: 'POST', body: payload });
    }
    setEditingId(null);
    setName('');
    setSubject('');
    setBody('');
    await onReload();
  }

  const visibleTemplates = templates.filter((t) => {
    if (!filterQ.trim()) return true;
    const hay = `${t.name} ${t.subject} ${t.category}`.toLowerCase();
    return hay.includes(filterQ.trim().toLowerCase());
  });

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
      <div style={{ maxWidth: 840, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Templates &amp; Saved Replies</h1>
          <div style={{ position: 'relative', width: 240 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
            <input className="field" style={{ paddingLeft: 30 }} placeholder="Search templates..." value={filterQ} onChange={(e) => setFilterQ(e.target.value)} />
          </div>
        </div>
        <form
          onSubmit={handleCreate}
          style={{
            padding: 16,
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 10 }}>
            <input className="field" placeholder="Template title" value={name} onChange={(e) => setName(e.target.value)} required />
            <input className="field" style={{ maxWidth: 160 }} placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <input className="field" placeholder="Default subject (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea className="field" rows={4} placeholder="Template body... Supports {{first_name}}, {{sender_name}}, {{today}}" value={body} onChange={(e) => setBody(e.target.value)} required />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['{{first_name}}', '{{sender_name}}', '{{today}}'].map((tok) => (
                <button
                  key={tok}
                  type="button"
                  className="chip"
                  style={{ cursor: 'pointer', border: 'none' }}
                  onClick={() => setBody((b) => (b ? `${b} ${tok}` : tok))}
                >
                  + {tok}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {editingId && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditingId(null);
                    setName('');
                    setSubject('');
                    setBody('');
                  }}
                >
                  Cancel
                </button>
              )}
              <button type="submit" className="btn btn-primary">
                <Plus size={14} /> {editingId ? 'Update Template' : 'Save Template'}
              </button>
            </div>
          </div>
        </form>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {visibleTemplates.map((t) => (
            <div
              key={t.id}
              style={{
                padding: 14,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-elevated)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
                  <FileText size={14} color="var(--accent)" /> {t.name}
                </strong>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    style={{ width: 26, height: 26 }}
                    onClick={() => {
                      setEditingId(t.id);
                      setName(t.name);
                      setSubject(t.subject);
                      setCategory(t.category || 'Work');
                      setBody(t.bodyHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim());
                    }}
                    aria-label={`Edit template ${t.name}`}
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    style={{ width: 26, height: 26 }}
                    onClick={async () => {
                      await apiRequest(`/productivity/templates/${t.id}`, { method: 'DELETE' });
                      await onReload();
                    }}
                    aria-label={`Delete template ${t.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {t.subject && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Subject: {t.subject}</div>}
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }} dangerouslySetInnerHTML={{ __html: t.bodyHtml }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RemindersView({
  onOpenThread,
  onCountChange,
}: {
  onOpenThread: (threadId: string) => void;
  onCountChange: (pendingCount: number) => void;
}) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));

  async function load() {
    const res = await apiRequest<{ reminders: Reminder[] }>('/productivity/reminders');
    setReminders(res.reminders);
    onCountChange(res.reminders.filter((r) => r.status === 'pending' || r.status === 'triggered').length);
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Follow-up Reminders</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await apiRequest('/productivity/reminders', {
              method: 'POST',
              body: { title, dueAt: new Date(dueAt).toISOString() },
            });
            setTitle('');
            await load();
          }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          <input className="field" style={{ flex: 2, minWidth: 200 }} placeholder="Reminder title..." value={title} onChange={(e) => setTitle(e.target.value)} required />
          <input type="datetime-local" className="field" style={{ flex: 1, minWidth: 180 }} value={dueAt} onChange={(e) => setDueAt(e.target.value)} required />
          <button type="submit" className="btn btn-primary">
            <Plus size={14} /> Add Reminder
          </button>
        </form>

        {reminders.length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>
            <BellRing size={26} style={{ opacity: 0.45, marginBottom: 8 }} />
            <div>No reminders scheduled</div>
          </div>
        ) : (
          reminders.map((r) => (
            <div
              key={r.id}
              style={{
                padding: 12,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-hairline)',
                background: 'var(--bg-elevated)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                opacity: r.status === 'completed' ? 0.6 : 1,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5, textDecoration: r.status === 'completed' ? 'line-through' : 'none' }}>
                  {r.title}
                </div>
                <div className="tabular" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Due: {new Date(r.dueAt).toLocaleString()} · Status: {r.status}
                  {r.threadSubject && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        style={{ border: 'none', background: 'transparent', padding: 0, color: 'var(--accent)', fontSize: 12 }}
                        onClick={() => r.threadId && onOpenThread(r.threadId)}
                      >
                        Open thread: {r.threadSubject}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {r.status !== 'completed' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      await apiRequest(`/productivity/reminders/${r.id}`, { method: 'PATCH', body: { status: 'completed' } });
                      await load();
                    }}
                  >
                    <Check size={13} /> Done
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={async () => {
                    await apiRequest(`/productivity/reminders/${r.id}`, { method: 'DELETE' });
                    await load();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
