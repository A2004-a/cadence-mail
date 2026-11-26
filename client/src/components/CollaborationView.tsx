import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { Paperclip, Plus, Send, Shield, Trash2, Users } from 'lucide-react';
import { ApiError, apiRequest } from '../api/client';
import type { Account, SharedMailbox, ThreadNote } from '../types';
import { formatBytes } from './CadenceMark';

interface SharedThreadRow {
  id: string;
  subject: string;
  snippet: string;
  lastMessageAt: string;
  unreadCount: number;
  assignedToUserId: string | null;
  assigneeName: string | null;
  triageStatus: 'open' | 'pending' | 'resolved';
  noteCount: number;
}

interface SharedThreadMessage {
  id: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  bodyHtmlSanitized: string;
  bodyText: string;
  receivedAt: string;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
}

interface MemberRow {
  user_id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
}

export function CollaborationView({
  accounts,
}: {
  accounts: Account[];
}) {
  const [mailboxes, setMailboxes] = useState<SharedMailbox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threads, setThreads] = useState<SharedThreadRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<SharedThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [notes, setNotes] = useState<ThreadNote[]>([]);
  const [noteInput, setNoteInput] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newAcctId, setNewAcctId] = useState(accounts[0]?.id || '');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'agent' | 'viewer'>('agent');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  async function loadMailboxes() {
    const res = await apiRequest<{ mailboxes: SharedMailbox[] }>('/workspace/collaboration/mailboxes');
    setMailboxes(res.mailboxes);
    if (!selectedId && res.mailboxes.length > 0) setSelectedId(res.mailboxes[0].id);
  }

  async function loadDetails(mailboxId: string) {
    const [tRes, mRes] = await Promise.all([
      apiRequest<{ threads: SharedThreadRow[] }>(`/workspace/collaboration/mailboxes/${mailboxId}/threads`),
      apiRequest<{ members: MemberRow[] }>(`/workspace/collaboration/mailboxes/${mailboxId}/members`),
    ]);
    setThreads(tRes.threads);
    setMembers(mRes.members);
  }

  async function loadNotes(mailboxId: string, threadId: string) {
    setLoadingThread(true);
    try {
      const [notesRes, threadRes] = await Promise.all([
        apiRequest<{ notes: ThreadNote[] }>(
          `/workspace/collaboration/mailboxes/${mailboxId}/threads/${threadId}/notes`
        ),
        apiRequest<{ messages: SharedThreadMessage[] }>(
          `/workspace/collaboration/mailboxes/${mailboxId}/threads/${threadId}`
        ),
      ]);
      setNotes(notesRes.notes);
      setThreadMessages(threadRes.messages);
    } finally {
      setLoadingThread(false);
    }
  }

  useEffect(() => {
    void loadMailboxes();
  }, []);

  useEffect(() => {
    if (selectedId) {
      void loadDetails(selectedId);
      setSelectedThreadId(null);
      setNotes([]);
      setThreadMessages([]);
      setReplyText('');
    }
  }, [selectedId]);

  useEffect(() => {
    if (selectedId) {
      void loadDetails(selectedId);
      setSelectedThreadId(null);
      setNotes([]);
      setThreadMessages([]);
    }
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && selectedThreadId) {
      void loadNotes(selectedId, selectedThreadId);
    }
  }, [selectedId, selectedThreadId]);

  const activeMailbox = mailboxes.find((m) => m.id === selectedId) || null;
  const canManage = activeMailbox?.role === 'owner' || activeMailbox?.role === 'admin';
  const canEditTriage = activeMailbox && activeMailbox.role !== 'viewer';

  return (
    <div className="cadence-subview-shell">
      <div className="cadence-subview-nav">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px 8px' }}>
          <strong style={{ fontSize: 13 }}>Team Inboxes</strong>
          <button type="button" className="btn btn-ghost btn-icon" style={{ width: 24, height: 24 }} onClick={() => setCreateOpen(true)} title="Share a mailbox" aria-label="Share a mailbox">
            <Plus size={14} />
          </button>
        </div>
        {mailboxes.map((mb) => (
          <button
            key={mb.id}
            type="button"
            className="btn btn-ghost btn-sm"
            style={{
              justifyContent: 'space-between',
              background: selectedId === mb.id ? 'var(--accent-soft)' : 'transparent',
              color: selectedId === mb.id ? 'var(--accent)' : 'var(--text-primary)',
            }}
            onClick={() => setSelectedId(mb.id)}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mb.name}</span>
            <span className="tabular">{mb.openThreads}</span>
          </button>
        ))}
        {mailboxes.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
            Private personal accounts stay isolated unless explicitly shared here.
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {statusMsg && (
            <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--status-info-bg)', color: 'var(--status-info)', fontSize: 12.5 }}>
              {statusMsg}
            </div>
          )}

          {!activeMailbox ? (
            <div style={{ padding: 36, textAlign: 'center', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)' }}>
              <Users size={28} style={{ color: 'var(--accent)', marginBottom: 8 }} />
              <div style={{ fontSize: 15.5, fontWeight: 700 }}>Shared Mailboxes & Team Desk</div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 440, margin: '6px auto 14px' }}>
                Explicitly share Support, Sales, or Operations mailboxes with role-based permissions, thread assignment, and internal team notes without exposing private mail.
              </p>
              {accounts.length > 0 && (
                <button type="button" className="btn btn-primary" onClick={() => { setNewAcctId(accounts[0].id); setCreateOpen(true); }}>
                  <Plus size={14} /> Share an Owned Mailbox
                </button>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{activeMailbox.name}</h1>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    Mailbox: {activeMailbox.emailAddress} · Your role: <strong>{activeMailbox.role}</strong>
                  </div>
                </div>
              </div>

              {canManage && (
                <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <strong style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Shield size={14} color="var(--accent)" /> Team Members & Permissions
                  </strong>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setStatusMsg(null);
                      try {
                        await apiRequest(`/workspace/collaboration/mailboxes/${activeMailbox.id}/members`, {
                          method: 'POST',
                          body: { email: memberEmail, role: memberRole },
                        });
                        setMemberEmail('');
                        await loadDetails(activeMailbox.id);
                      } catch (err) {
                        setStatusMsg(err instanceof ApiError ? err.message : 'Unable to add team member');
                      }
                    }}
                    style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
                  >
                    <input className="field" style={{ flex: 2, minWidth: 200 }} placeholder="Workspace teammate email..." value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} required />
                    <select className="field" style={{ width: 130 }} value={memberRole} onChange={(e) => setMemberRole(e.target.value as typeof memberRole)}>
                      <option value="agent">Agent</option>
                      <option value="admin">Admin</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button type="submit" className="btn btn-sm btn-primary">Add Member</button>
                  </form>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {members.map((m) => (
                      <span key={m.user_id} className="chip" style={{ gap: 6 }}>
                        <span>{m.name} ({m.role})</span>
                        {m.role !== 'owner' && (
                          <button
                            type="button"
                            style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }}
                            onClick={async () => {
                              await apiRequest(`/workspace/collaboration/mailboxes/${activeMailbox.id}/members/${m.user_id}`, { method: 'DELETE' });
                              await loadDetails(activeMailbox.id);
                            }}
                            aria-label={`Remove ${m.email}`}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: selectedThreadId ? '1.3fr 1fr' : '1fr', gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {threads.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
                      No conversations in this shared mailbox yet.
                    </div>
                  ) : (
                    threads.map((t) => (
                      <div
                        key={t.id}
                        style={{
                          padding: 12,
                          borderRadius: 'var(--radius-lg)',
                          border: `1px solid ${selectedThreadId === t.id ? 'var(--accent)' : 'var(--border-subtle)'}`,
                          background: 'var(--bg-elevated)',
                          cursor: 'pointer',
                        }}
                        onClick={() => setSelectedThreadId(t.id)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 13.5 }}>{t.subject}</strong>
                          <span className="chip" style={{ height: 20, fontSize: 10.5, textTransform: 'capitalize' }}>{t.triageStatus}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.snippet}</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                          <select
                            className="field"
                            style={{ width: 160, height: 26, fontSize: 11.5 }}
                            disabled={!canEditTriage}
                            value={t.assignedToUserId || ''}
                            onChange={async (e) => {
                              await apiRequest(`/workspace/collaboration/mailboxes/${activeMailbox.id}/threads/${t.id}/assign`, {
                                method: 'POST',
                                body: { assignedToUserId: e.target.value || null, status: t.triageStatus },
                              });
                              await loadDetails(activeMailbox.id);
                            }}
                          >
                            <option value="">Unassigned</option>
                            {members.map((m) => (
                              <option key={m.user_id} value={m.user_id}>{m.name}</option>
                            ))}
                          </select>
                          <select
                            className="field"
                            style={{ width: 110, height: 26, fontSize: 11.5 }}
                            disabled={!canEditTriage}
                            value={t.triageStatus}
                            onChange={async (e) => {
                              await apiRequest(`/workspace/collaboration/mailboxes/${activeMailbox.id}/threads/${t.id}/assign`, {
                                method: 'POST',
                                body: { assignedToUserId: t.assignedToUserId, status: e.target.value },
                              });
                              await loadDetails(activeMailbox.id);
                            }}
                          >
                            <option value="open">Open</option>
                            <option value="pending">Pending</option>
                            <option value="resolved">Resolved</option>
                          </select>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.noteCount} note(s)</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {selectedThreadId && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <strong style={{ fontSize: 13.5 }}>Shared Conversation</strong>
                      {loadingThread ? (
                        <div className="skeleton" style={{ height: 90, borderRadius: 'var(--radius-md)' }} />
                      ) : threadMessages.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No messages available in this thread.</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 340, overflowY: 'auto' }}>
                          {threadMessages.map((m) => (
                            <div key={m.id} style={{ padding: 10, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-hairline)', background: 'var(--bg-subtle)' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5, marginBottom: 6, gap: 8 }}>
                                <span>
                                  <strong>{m.fromName || m.fromAddress}</strong>{' '}
                                  <span style={{ color: 'var(--text-muted)' }}>&lt;{m.fromAddress}&gt;</span>
                                </span>
                                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                  {new Date(m.receivedAt).toLocaleString()}
                                </span>
                              </div>
                              <div
                                style={{ fontSize: 12.5, lineHeight: 1.55, overflowWrap: 'anywhere' }}
                                dangerouslySetInnerHTML={{
                                  __html: DOMPurify.sanitize(
                                    m.bodyHtmlSanitized || `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${m.bodyText || ''}</pre>`,
                                    {
                                      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
                                      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
                                    }
                                  ),
                                }}
                              />
                              {m.attachments.length > 0 && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                                  {m.attachments.map((att) => (
                                    <a
                                      key={att.id}
                                      href={`/api/v1/workspace/collaboration/mailboxes/${activeMailbox.id}/attachments/${att.id}`}
                                      download={att.filename}
                                      className="btn btn-sm"
                                      style={{ height: 24, fontSize: 11 }}
                                    >
                                      <Paperclip size={11} /> {att.filename} ({formatBytes(att.sizeBytes)})
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {canEditTriage && threadMessages.length > 0 && (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!replyText.trim() || replySending) return;
                            setReplySending(true);
                            setStatusMsg(null);
                            try {
                              const res = await apiRequest<{ recipients?: string[] }>(
                                `/workspace/collaboration/mailboxes/${activeMailbox.id}/threads/${selectedThreadId}/reply`,
                                { method: 'POST', body: { text: replyText.trim() } }
                              );
                              setReplyText('');
                              setStatusMsg(
                                `Sent shared reply via ${activeMailbox.emailAddress}${res.recipients?.length ? ` to ${res.recipients.join(', ')}` : ''}.`
                              );
                              await loadNotes(activeMailbox.id, selectedThreadId);
                              await loadDetails(activeMailbox.id);
                            } catch (err) {
                              setStatusMsg(err instanceof ApiError ? err.message : 'Failed to send shared reply');
                            } finally {
                              setReplySending(false);
                            }
                          }}
                          style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}
                        >
                          <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                            Reply publicly as {activeMailbox.emailAddress}
                          </label>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <textarea
                              className="field"
                              rows={2}
                              placeholder={`Write external reply from ${activeMailbox.emailAddress}...`}
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                            />
                            <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end', whiteSpace: 'nowrap' }} disabled={replySending || !replyText.trim()}>
                              <Send size={12} /> {replySending ? 'Sending...' : 'Send Shared Reply'}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>

                    <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 10, height: 'fit-content' }}>
                      <strong style={{ fontSize: 13.5 }}>Internal Team Notes (Private — never emailed)</strong>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                        {notes.map((n) => (
                          <div key={n.id} style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                              <strong>{n.authorName}</strong>
                              <span>{new Date(n.createdAt).toLocaleString()}</span>
                            </div>
                            <div>{n.body}</div>
                          </div>
                        ))}
                        {notes.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No internal notes yet.</div>}
                      </div>
                      {canEditTriage && (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!noteInput.trim()) return;
                            await apiRequest(`/workspace/collaboration/mailboxes/${activeMailbox.id}/threads/${selectedThreadId}/notes`, {
                              method: 'POST',
                              body: { body: noteInput.trim() },
                            });
                            setNoteInput('');
                            await loadNotes(activeMailbox.id, selectedThreadId);
                            await loadDetails(activeMailbox.id);
                          }}
                          style={{ display: 'flex', gap: 6 }}
                        >
                          <input className="field" placeholder="Write private team note..." value={noteInput} onChange={(e) => setNoteInput(e.target.value)} />
                          <button type="submit" className="btn btn-primary btn-sm"><Send size={12} /></button>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {createOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }}
          onClick={() => setCreateOpen(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/workspace/collaboration/mailboxes', {
                method: 'POST',
                body: { accountId: newAcctId, name: newName, description: newDesc },
              });
              setCreateOpen(false);
              setNewName('');
              setNewDesc('');
              await loadMailboxes();
            }}
            style={{ width: '100%', maxWidth: 420, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', padding: 20, border: '1px solid var(--border-strong)', display: 'flex', flexDirection: 'column', gap: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong>Share Mailbox with Team</strong>
            <select className="field" value={newAcctId} onChange={(e) => setNewAcctId(e.target.value)} required>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.emailAddress}</option>
              ))}
            </select>
            <input className="field" placeholder="Shared inbox name (e.g. Support Desk)" value={newName} onChange={(e) => setNewName(e.target.value)} required />
            <input className="field" placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Shared Inbox</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
