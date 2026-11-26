import { useEffect, useState } from 'react';
import { Download, Eye, Paperclip, Search, X } from 'lucide-react';
import { apiRequest } from '../api/client';
import type { Account, AttachmentLibraryItem } from '../types';
import { formatBytes } from './CadenceMark';

export function AttachmentsView({
  accounts,
  onOpenThread,
}: {
  accounts: Account[];
  onOpenThread: (threadId: string) => void;
}) {
  const [items, setItems] = useState<AttachmentLibraryItem[]>([]);
  const [stats, setStats] = useState({ totalCount: 0, totalBytes: 0, duplicateGroups: 0 });
  const [q, setQ] = useState('');
  const [type, setType] = useState<'all' | 'image' | 'document' | 'spreadsheet' | 'archive' | 'other'>('all');
  const [accountId, setAccountId] = useState('');
  const [sort, setSort] = useState<'newest' | 'largest' | 'name'>('newest');
  const [previewItem, setPreviewItem] = useState<AttachmentLibraryItem | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  async function load() {
    const params = new URLSearchParams({ type, sort });
    if (q.trim()) params.set('q', q.trim());
    if (accountId) params.set('accountId', accountId);
    const res = await apiRequest<{ attachments: AttachmentLibraryItem[]; stats: typeof stats }>(
      `/workspace/attachments?${params.toString()}`
    );
    setItems(res.attachments);
    setStats(res.stats);
  }

  useEffect(() => {
    void load();
  }, [q, type, accountId, sort]);

  useEffect(() => {
    if (!previewItem || previewItem.mimeType.startsWith('image/')) {
      setPreviewText(null);
      return;
    }
    const ctrl = new AbortController();
    fetch(`/api/v1/threads/attachments/${previewItem.id}`, { credentials: 'include', signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => setPreviewText(t.slice(0, 200_000)))
      .catch(() => setPreviewText('Binary preview not supported inline; click Download to open file.'));
    return () => ctrl.abort();
  }, [previewItem]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Paperclip size={18} color="var(--accent)" /> Attachment Library
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
              {stats.totalCount} file(s) · <span className="tabular">{formatBytes(stats.totalBytes)}</span> stored · {stats.duplicateGroups} SHA-256 duplicate group(s)
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', minWidth: 220 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
              <input
                className="field"
                style={{ paddingLeft: 30 }}
                placeholder="Search filenames or senders..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <select className="field" style={{ width: 170 }} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.emailAddress}</option>
              ))}
            </select>
            <select className="field" style={{ width: 130 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="newest">Newest</option>
              <option value="largest">Largest</option>
              <option value="name">Filename</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['all', 'image', 'document', 'spreadsheet', 'archive', 'other'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`btn btn-sm ${type === t ? 'btn-primary' : ''}`}
              style={{ borderRadius: 'var(--radius-pill)', textTransform: 'capitalize' }}
              onClick={() => setType(t)}
            >
              {t === 'all' ? 'All Files' : `${t}s`}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
            No matching attachments found.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {items.map((att) => (
              <div
                key={att.id}
                className="cadence-hub-card"
                style={{
                  padding: 14,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 13.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {att.filename}
                    </strong>
                    <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                      {formatBytes(att.sizeBytes)} · {att.mimeType}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" className="btn btn-ghost btn-icon" style={{ width: 28, height: 28 }} onClick={() => setPreviewItem(att)} aria-label={`Preview ${att.filename}`}>
                      <Eye size={13} />
                    </button>
                    <a href={`/api/v1/threads/attachments/${att.id}`} download={att.filename} className="btn btn-ghost btn-icon" style={{ width: 28, height: 28 }} aria-label={`Download ${att.filename}`}>
                      <Download size={13} />
                    </a>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  From: {att.fromName || att.fromAddress || 'Unknown'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 'auto' }}>
                  {att.threadId && (
                    <button
                      type="button"
                      style={{ border: 'none', background: 'transparent', padding: 0, color: 'var(--accent)', fontSize: 11.5, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onClick={() => onOpenThread(att.threadId!)}
                    >
                      {att.threadSubject || 'View email'}
                    </button>
                  )}
                  {att.duplicateCount > 1 && (
                    <span className="chip" style={{ height: 18, fontSize: 10 }}>Dup ×{att.duplicateCount}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {previewItem && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 24 }}
          onClick={() => setPreviewItem(null)}
        >
          <div
            style={{ width: '100%', maxWidth: 680, maxHeight: '85vh', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--border-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{previewItem.filename}</strong>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setPreviewItem(null)} aria-label="Close preview">
                <X size={15} />
              </button>
            </div>
            <div style={{ padding: 20, overflow: 'auto', textAlign: 'center' }}>
              {previewItem.mimeType.startsWith('image/') ? (
                <img src={`/api/v1/threads/attachments/${previewItem.id}?inline=1`} alt={previewItem.filename} style={{ maxWidth: '100%', maxHeight: '65vh' }} />
              ) : (
                <pre className="mono" style={{ textAlign: 'left', whiteSpace: 'pre-wrap', fontSize: 12.5, margin: 0, padding: 14, background: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)' }}>
                  {previewText ?? 'Loading...'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
