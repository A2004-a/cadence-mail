import React, { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  Archive,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  Pin,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Square,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import type {
  Account,
  Category,
  Draft,
  Folder,
  Label,
  MailView,
  SearchMeta,
  ThreadSummary,
  UserPreferences,
  ViewCounts,
} from '../types';
import { AvatarBadge, formatRelativeDate } from './CadenceMark';

interface EmailListProps {
  threads: ThreadSummary[];
  drafts: Draft[];
  activeView: MailView;
  activeCategory: string | null;
  categories: Category[];
  counts: ViewCounts;
  folders: Folder[];
  labels: Label[];
  accounts: Account[];
  selectedThreadId: string | null;
  selectedIds: Set<string>;
  loading: boolean;
  error: string | null;
  isOnline: boolean;
  sortBy: UserPreferences['inbox']['sortBy'];
  unreadOnly: boolean;
  hasAttachmentOnly: boolean;
  searchQuery: string;
  highlightTerms: string[];
  searchMeta?: SearchMeta | null;
  includeRemoteSearch?: boolean;
  onToggleRemoteSearch?: () => void;
  onSelectCategory: (slug: string | null) => void;
  onSelectThread: (id: string) => void;
  onToggleSelectId: (id: string, shiftKey?: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkAction: (
    threadIds: string[],
    action:
      | 'mark_read'
      | 'mark_unread'
      | 'star'
      | 'unstar'
      | 'important'
      | 'unimportant'
      | 'archive'
      | 'delete'
      | 'restore'
      | 'permanent_delete'
      | 'spam'
      | 'not_spam'
      | 'snooze'
      | 'unsnooze'
      | 'move_folder'
      | 'add_label'
      | 'pin'
      | 'unpin',
    extra?: { snoozedUntil?: string; folderId?: string; labelId?: string }
  ) => void;
  onChangeSort: (sort: UserPreferences['inbox']['sortBy']) => void;
  onToggleUnreadFilter: () => void;
  onToggleAttachmentFilter: () => void;
  onClearSearch: () => void;
  onOpenDraft: (draft: Draft) => void;
  onCancelScheduled: (draftId: string) => void;
  onDiscardDraft: (draftId: string) => void;
  onSyncNow: () => void;
  onReconnectAccount: () => void;
  onReplyThread: (threadId: string, mode: 'reply' | 'reply_all' | 'forward') => void;
  onConnectRealEmail?: () => void;
  onSeedSample?: () => void;
  onEmptyFolder?: (folder: 'trash' | 'spam') => Promise<void>;
  totalCount?: number;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  dateFormat: UserPreferences['general']['dateFormat'];
  timeFormat: UserPreferences['general']['timeFormat'];
  density: UserPreferences['appearance']['density'];
}

function highlightText(text: string, terms: string[]): React.ReactNode {
  if (!terms.length || !text) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
  if (!escaped.length) return text;
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} style={{ background: 'color-mix(in srgb, var(--accent) 22%, transparent)', color: 'inherit', padding: '0 2px', borderRadius: 2 }}>
        {p}
      </mark>
    ) : (
      p
    )
  );
}

export function EmailList(props: EmailListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const catStripRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; thread: ThreadSummary } | null>(null);
  const [bulkFolderOpen, setBulkFolderOpen] = useState(false);
  const [bulkLabelOpen, setBulkLabelOpen] = useState(false);
  const [confirmPermDeleteIds, setConfirmPermDeleteIds] = useState<string[] | null>(null);
  const [confirmEmptyFolder, setConfirmEmptyFolder] = useState<'trash' | 'spam' | null>(null);

  const authExpiredAccounts = props.accounts.filter((a) => a.status === 'auth_expired');
  const syncErrorAccounts = props.accounts.filter((a) => a.status === 'error');
  const enabledCategories = props.categories.filter((c) => c.enabled);

  const estimatedRowSize = props.density === 'compact' ? 56 : props.density === 'spacious' ? 88 : 74;
  const rowVirtualizer = useVirtualizer({
    count: props.threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowSize,
    overscan: 8,
  });

  const allSelected = props.threads.length > 0 && props.threads.every((t) => props.selectedIds.has(t.id));
  const selectedList = useMemo(() => Array.from(props.selectedIds), [props.selectedIds]);

  const viewTitle = useMemo(() => {
    const map: Record<MailView, string> = {
      inbox: 'Inbox',
      priority: 'Priority Inbox',
      unread: 'Unread',
      starred: 'Starred',
      important: 'Important',
      sent: 'Sent',
      drafts: 'Drafts & Scheduled',
      snoozed: 'Snoozed',
      archive: 'Archive',
      all: 'All Mail',
      spam: 'Spam',
      trash: 'Trash',
      folder: 'Folder',
      label: 'Label',
      search: `Search: "${props.searchQuery}"`,
    };
    return map[props.activeView] || 'Inbox';
  }, [props.activeView, props.searchQuery]);

  if (props.activeView === 'drafts') {
    return (
      <section aria-label="Drafts and scheduled messages" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-canvas)' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 15 }}>{viewTitle}</strong>
          <span className="tabular" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{props.drafts.length} items</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {props.drafts.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
              <Send size={28} style={{ opacity: 0.45, marginBottom: 10 }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>No saved drafts or scheduled emails</div>
              <p style={{ fontSize: 12.5, marginTop: 4 }}>Drafts autosave automatically as you compose.</p>
            </div>
          ) : (
            props.drafts.map((d) => (
              <div
                key={d.id}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--border-hairline)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <button
                  type="button"
                  onClick={() => props.onOpenDraft(d)}
                  style={{ flex: 1, border: 'none', background: 'transparent', textAlign: 'left', padding: 0 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      className="chip"
                      style={{
                        background:
                          d.status === 'scheduled'
                            ? 'var(--status-info-bg)'
                            : d.status === 'failed'
                              ? 'var(--status-danger-bg)'
                              : 'var(--bg-badge)',
                        color:
                          d.status === 'scheduled'
                            ? 'var(--status-info)'
                            : d.status === 'failed'
                              ? 'var(--status-danger)'
                              : 'var(--text-secondary)',
                      }}
                    >
                      {d.status === 'scheduled'
                        ? `Scheduled · ${new Date(d.scheduledFor!).toLocaleString()}`
                        : d.status === 'queued_undo'
                          ? 'Sending...'
                          : d.status === 'failed'
                            ? 'Failed'
                            : 'Draft'}
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)' }}>
                      {d.subject || '(no subject)'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                    To: {d.to.map((r) => r.address).join(', ') || '(no recipients)'}
                  </div>
                  {d.lastError && <div style={{ fontSize: 12, color: 'var(--status-danger)', marginTop: 2 }}>{d.lastError}</div>}
                </button>
                <div style={{ display: 'flex', gap: 6 }}>
                  {d.status === 'scheduled' && (
                    <button type="button" className="btn btn-sm" onClick={() => props.onCancelScheduled(d.id)}>
                      Unschedule
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    onClick={() => props.onDiscardDraft(d.id)}
                    title="Discard draft"
                    aria-label="Discard draft"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Message list"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-canvas)',
        position: 'relative',
      }}
      onClick={() => contextMenu && setContextMenu(null)}
    >
      {/* Account Error / Auth Expired Alerts */}
      {authExpiredAccounts.length > 0 && (
        <div
          style={{
            padding: '8px 14px',
            background: 'var(--status-warning-bg)',
            color: 'var(--status-warning)',
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldAlert size={15} />
            Authentication expired for {authExpiredAccounts.map((a) => a.emailAddress).join(', ')}.
          </span>
          <button type="button" className="btn btn-sm" onClick={props.onReconnectAccount}>
            Reconnect
          </button>
        </div>
      )}

      {syncErrorAccounts.length > 0 && (
        <div
          style={{
            padding: '8px 14px',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger)',
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={15} />
            Sync failed: {syncErrorAccounts[0].lastError || 'Check connection settings'}
          </span>
          <button type="button" className="btn btn-sm" onClick={props.onSyncNow}>
            Retry
          </button>
        </div>
      )}

      {/* List Header / Bulk Actions */}
      <div
        style={{
          padding: '8px 14px',
          borderBottom: '1px solid var(--border-hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minHeight: 46,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 28, height: 28 }}
            onClick={() => (allSelected ? props.onClearSelection() : props.onSelectAll())}
            title={allSelected ? 'Clear selection' : 'Select all'}
            aria-label={allSelected ? 'Clear selection' : 'Select all'}
          >
            {allSelected ? <CheckSquare size={16} color="var(--accent)" /> : <Square size={16} />}
          </button>

          {selectedList.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span className="tabular" style={{ fontSize: 12, fontWeight: 600, marginRight: 4 }}>
                {selectedList.length} selected
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 28, height: 28 }}
                onClick={() => props.onBulkAction(selectedList, 'archive')}
                title="Archive selected (E)"
                aria-label="Archive selected"
              >
                <Archive size={15} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 28, height: 28 }}
                onClick={() => {
                  if (props.activeView === 'trash') {
                    setConfirmPermDeleteIds(selectedList);
                  } else {
                    props.onBulkAction(selectedList, 'delete');
                  }
                }}
                title={props.activeView === 'trash' ? 'Delete permanently' : 'Delete selected (#)'}
                aria-label="Delete selected"
              >
                <Trash2 size={15} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 28, height: 28 }}
                onClick={() => props.onBulkAction(selectedList, 'mark_read')}
                title="Mark read"
                aria-label="Mark read"
              >
                <MailOpen size={15} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 28, height: 28 }}
                onClick={() => props.onBulkAction(selectedList, 'mark_unread')}
                title="Mark unread"
                aria-label="Mark unread"
              >
                <Mail size={15} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 28, height: 28 }}
                onClick={() => props.onBulkAction(selectedList, 'star')}
                title="Star selected"
                aria-label="Star selected"
              >
                <Star size={15} />
              </button>
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ width: 28, height: 28 }}
                  onClick={() => {
                    setBulkFolderOpen((v) => !v);
                    setBulkLabelOpen(false);
                  }}
                  title="Move to folder"
                  aria-label="Move to folder"
                >
                  <FolderInput size={15} />
                </button>
                {bulkFolderOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 32,
                      left: 0,
                      minWidth: 170,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius-md)',
                      boxShadow: 'var(--shadow-lg)',
                      padding: 4,
                      zIndex: 50,
                    }}
                  >
                    {props.folders
                      .filter((f) => f.systemRole === 'custom' || f.systemRole === 'inbox' || f.systemRole === 'archive')
                      .slice(0, 12)
                      .map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ width: '100%', justifyContent: 'flex-start' }}
                          onClick={() => {
                            props.onBulkAction(selectedList, 'move_folder', { folderId: f.id });
                            setBulkFolderOpen(false);
                          }}
                        >
                          {f.name}
                        </button>
                      ))}
                  </div>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ width: 28, height: 28 }}
                  onClick={() => {
                    setBulkLabelOpen((v) => !v);
                    setBulkFolderOpen(false);
                  }}
                  title="Apply label"
                  aria-label="Apply label"
                >
                  <Tag size={15} />
                </button>
                {bulkLabelOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 32,
                      left: 0,
                      minWidth: 160,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius-md)',
                      boxShadow: 'var(--shadow-lg)',
                      padding: 4,
                      zIndex: 50,
                    }}
                  >
                    {props.labels.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ width: '100%', justifyContent: 'flex-start' }}
                        onClick={() => {
                          props.onBulkAction(selectedList, 'add_label', { labelId: l.id });
                          setBulkLabelOpen(false);
                        }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: l.color }} />
                        {l.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {props.activeView === 'trash' || props.activeView === 'spam' ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onBulkAction(selectedList, 'restore')}
                >
                  Restore to Inbox
                </button>
              ) : null}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, letterSpacing: '-0.015em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {viewTitle}
              </h2>
              <span
                className="tabular"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '1px 7px',
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--bg-badge)',
                  color: 'var(--text-secondary)',
                }}
              >
                {typeof props.totalCount === 'number' && props.totalCount > props.threads.length
                  ? `${props.threads.length} / ${props.totalCount}`
                  : props.threads.length}
              </span>
            </div>
          )}
        </div>

        {/* Filter & Sort Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <button
            type="button"
            className={`btn btn-sm ${props.unreadOnly ? 'btn-primary' : 'btn-ghost'}`}
            style={{ height: 26, fontSize: 11.5, borderRadius: 'var(--radius-pill)', padding: '0 10px' }}
            onClick={props.onToggleUnreadFilter}
          >
            Unread
          </button>
          <button
            type="button"
            className={`btn btn-sm ${props.hasAttachmentOnly ? 'btn-primary' : 'btn-ghost'}`}
            style={{ height: 26, fontSize: 11.5, borderRadius: 'var(--radius-pill)', padding: '0 8px' }}
            onClick={props.onToggleAttachmentFilter}
            title="Filter by attachment"
          >
            <Paperclip size={12} />
          </button>
          <select
            aria-label="Sort messages"
            className="field"
            style={{ width: 'auto', height: 26, fontSize: 11.5, padding: '0 8px', borderRadius: 'var(--radius-pill)' }}
            value={props.sortBy}
            onChange={(e) => props.onChangeSort(e.target.value as UserPreferences['inbox']['sortBy'])}
          >
            <option value="date_desc">Newest</option>
            <option value="date_asc">Oldest</option>
            <option value="priority">Priority</option>
            <option value="sender">Sender</option>
          </select>
        </div>
      </div>

      {/* Trash / Spam One-Click Purge Bar */}
      {(props.activeView === 'trash' || props.activeView === 'spam') && props.threads.length > 0 && props.onEmptyFolder && (
        <div
          style={{
            padding: '7px 14px',
            borderBottom: '1px solid var(--border-hairline)',
            background: 'var(--bg-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>
            {props.activeView === 'trash'
              ? 'Deleted items remain recoverable until purged.'
              : 'Spam conversations are hidden from search and inbox.'}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            style={{ height: 24, fontSize: 11.5 }}
            onClick={() => setConfirmEmptyFolder(props.activeView as 'trash' | 'spam')}
          >
            Empty {props.activeView === 'trash' ? 'Trash' : 'Spam'} Now
          </button>
        </div>
      )}

      {/* Category Tabs for Inbox */}
      {props.activeView === 'search' && props.searchMeta && (
        <div
          style={{
            padding: '7px 14px',
            borderBottom: '1px solid var(--border-hairline)',
            background: 'var(--bg-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-secondary)' }}>
              Scope: <strong>{props.searchMeta.remoteQueried ? 'Local FTS5 + Live Remote Providers' : 'Local FTS5 + Cached Mail'}</strong>
            </span>
            {props.searchMeta.accountStatuses.map((s) => (
              <span
                key={s.accountId}
                className="chip"
                style={{
                  height: 20,
                  fontSize: 10.5,
                  color: s.status === 'ok' ? 'var(--text-secondary)' : 'var(--status-warning)',
                }}
                title={s.error || `${s.emailAddress} (${s.scope})`}
              >
                {s.emailAddress}: {s.status === 'ok' ? (s.scope === 'remote_merged' ? `+${s.remoteMatches} remote` : 'indexed') : s.status}
              </span>
            ))}
          </div>
          {props.onToggleRemoteSearch && (
            <button
              type="button"
              className={`btn btn-sm ${props.includeRemoteSearch ? 'btn-primary' : ''}`}
              style={{ height: 24, fontSize: 11 }}
              onClick={props.onToggleRemoteSearch}
            >
              {props.includeRemoteSearch ? 'Remote Search On' : 'Query Live Remote Mail'}
            </button>
          )}
        </div>
      )}

      {props.activeView === 'inbox' && enabledCategories.length > 0 && (props.threads.length > 0 || Boolean(props.activeCategory)) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '7px 8px',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          {enabledCategories.length > 5 && (
            <button
              type="button"
              className="btn btn-ghost btn-icon cadence-desktop-only"
              style={{ width: 22, height: 24, flexShrink: 0 }}
              onClick={() => catStripRef.current?.scrollBy({ left: -160, behavior: 'smooth' })}
              title="Scroll categories left"
              aria-label="Scroll categories left"
            >
              <ChevronLeft size={13} />
            </button>
          )}
          <div
            ref={catStripRef}
            className="cadence-no-scrollbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              flex: 1,
              flexWrap: 'nowrap',
              overflowX: 'auto',
            }}
          >
            <button
              type="button"
              onClick={() => props.onSelectCategory(null)}
              className="btn btn-sm"
              style={{
                height: 25,
                padding: '0 10px',
                fontSize: 12,
                flexShrink: 0,
                whiteSpace: 'nowrap',
                borderRadius: 'var(--radius-pill)',
                background: !props.activeCategory ? 'var(--accent-soft)' : 'transparent',
                borderColor: !props.activeCategory ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'transparent',
                color: !props.activeCategory ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              All
            </button>
            {enabledCategories.map((cat) => {
              const isAct = props.activeCategory === cat.slug;
              const unread = props.counts.categories[cat.slug]?.unread || 0;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => props.onSelectCategory(cat.slug)}
                  className="btn btn-sm"
                  style={{
                    height: 25,
                    padding: '0 10px',
                    fontSize: 12,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    borderRadius: 'var(--radius-pill)',
                    background: isAct ? 'var(--accent-soft)' : 'transparent',
                    borderColor: isAct ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'transparent',
                    color: isAct ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: cat.color }} />
                  <span>{cat.name}</span>
                  {unread > 0 && <span className="tabular" style={{ fontSize: 11, fontWeight: 600 }}>{unread}</span>}
                </button>
              );
            })}
          </div>
          {enabledCategories.length > 5 && (
            <button
              type="button"
              className="btn btn-ghost btn-icon cadence-desktop-only"
              style={{ width: 22, height: 24, flexShrink: 0 }}
              onClick={() => catStripRef.current?.scrollBy({ left: 160, behavior: 'smooth' })}
              title="Scroll categories right"
              aria-label="Scroll categories right"
            >
              <ChevronRight size={13} />
            </button>
          )}
        </div>
      )}

      {/* Virtualized Scroll List */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        {props.loading ? (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 99 }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="skeleton" style={{ height: 14, width: '38%' }} />
                  <div className="skeleton" style={{ height: 12, width: '78%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : props.error ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <AlertTriangle size={28} color="var(--status-danger)" style={{ marginBottom: 8 }} />
            <div style={{ fontWeight: 600 }}>Unable to load messages</div>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{props.error}</p>
            <button type="button" className="btn btn-sm" onClick={props.onSyncNow}>
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        ) : props.threads.length === 0 ? (
          <div
            style={{
              minHeight: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '28px 20px',
            }}
          >
            <div
              className="cadence-hub-card"
              style={{
                width: '100%',
                maxWidth: 340,
                padding: '28px 24px',
                borderRadius: 'var(--radius-xl)',
                background: 'var(--bg-canvas)',
                border: '1px solid var(--border-subtle)',
                boxShadow: 'var(--shadow-sm)',
                textAlign: 'center',
              }}
            >
              {props.activeView === 'search' ? (
                <>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 'var(--radius-lg)',
                      background: 'var(--bg-subtle)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 12,
                    }}
                  >
                    <Search size={20} style={{ color: 'var(--text-muted)' }} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>
                    No matching conversations
                  </div>
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, marginBottom: 16, lineHeight: 1.55 }}>
                    Try broader terms or clear filters to inspect all correspondence.
                  </p>
                  <button type="button" className="btn btn-sm" onClick={props.onClearSearch}>
                    Clear search
                  </button>
                </>
              ) : (
                <>
                  <div
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 'var(--radius-lg)',
                      background: 'var(--accent-soft)',
                      color: 'var(--accent)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 14,
                    }}
                  >
                    <Inbox size={22} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15.5, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>
                    {props.activeView === 'inbox'
                      ? props.accounts.some((a) => a.providerType !== 'local')
                        ? 'Your inbox is clear'
                        : 'Connect Your Real Email'
                      : `Nothing in ${viewTitle}`}
                  </div>
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 6, marginBottom: 18 }}>
                    {!props.isOnline
                      ? 'You are offline. Cached messages remain available where synced.'
                      : props.activeView === 'inbox' && !props.accounts.some((a) => a.providerType !== 'local')
                      ? 'Connect Gmail, Outlook / Microsoft 365, Yahoo, iCloud, Zoho, Fastmail, or any IMAP/SMTP server to sync and send real emails.'
                      : 'Incoming mail from your connected accounts will appear here.'}
                  </p>
                  {props.activeView === 'inbox' && props.onConnectRealEmail && !props.accounts.some((a) => a.providerType !== 'local') && (
                    <button type="button" className="btn btn-primary" onClick={props.onConnectRealEmail}>
                      Connect Real Email
                    </button>
                  )}
                  {props.activeView === 'inbox' && props.accounts.some((a) => a.providerType !== 'local') && (
                    <button type="button" className="btn btn-sm" onClick={props.onSyncNow}>
                      <RefreshCw size={13} /> Sync Real Mail Now
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="Conversations"
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const t = props.threads[vRow.index];
              const isSelected = props.selectedThreadId === t.id;
              const isChecked = props.selectedIds.has(t.id);
              const isUnread = t.unreadCount > 0;
              const leadSender = t.participants[t.participants.length - 1] || { name: t.accountName, address: t.accountEmail };

              return (
                <div
                  key={t.id}
                  role="option"
                  aria-selected={isSelected}
                  draggable
                  onDragStart={(e) => {
                    const dragIds = isChecked ? selectedList : [t.id];
                    e.dataTransfer.setData('application/cadence-threads', JSON.stringify(dragIds));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, thread: t });
                  }}
                  onClick={() => props.onSelectThread(t.id)}
                  className="cadence-thread-row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${vRow.size}px`,
                    transform: `translateY(${vRow.start}px)`,
                    padding: 'var(--row-py) var(--row-px)',
                    borderLeft: isSelected
                      ? '3px solid var(--accent)'
                      : isUnread
                        ? '3px solid color-mix(in srgb, var(--accent) 55%, transparent)'
                        : '3px solid transparent',
                    borderBottom: '1px solid var(--border-hairline)',
                    background: isSelected
                      ? 'var(--bg-selected)'
                      : isUnread
                        ? 'var(--bg-canvas)'
                        : 'color-mix(in srgb, var(--bg-subtle) 42%, var(--bg-canvas))',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.subject}`}
                    checked={isChecked}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onToggleSelectId(t.id, e.shiftKey);
                    }}
                    onChange={() => { }}
                  />

                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    style={{ width: 24, height: 24 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onBulkAction([t.id], t.isStarred ? 'unstar' : 'star');
                    }}
                    aria-label={t.isStarred ? 'Remove star' : 'Star conversation'}
                  >
                    <Star
                      size={14}
                      fill={t.isStarred ? '#F59E0B' : 'none'}
                      color={t.isStarred ? '#F59E0B' : 'var(--text-muted)'}
                    />
                  </button>

                  <AvatarBadge name={leadSender.name || leadSender.address} color={t.accountColor} size={30} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        {isUnread && (
                          <span
                            style={{ width: 7, height: 7, minWidth: 7, borderRadius: 99, background: 'var(--accent)' }}
                            title="Unread"
                          />
                        )}
                        {t.isPinned && <Pin size={12} color="var(--accent)" />}
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: isUnread ? 700 : 500,
                            color: 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {highlightText(leadSender.name || leadSender.address, props.highlightTerms)}
                        </span>
                        {t.messageCount > 1 && (
                          <span
                            className="tabular"
                            style={{
                              fontSize: 11,
                              padding: '0 5px',
                              borderRadius: 'var(--radius-xs)',
                              background: 'var(--bg-badge)',
                              color: 'var(--text-secondary)',
                              fontWeight: 600,
                            }}
                          >
                            {t.messageCount}
                          </span>
                        )}
                        {t.syncPending && (
                          <span className="chip" style={{ height: 18, fontSize: 10, background: 'var(--status-warning-bg)', color: 'var(--status-warning)' }}>
                            Queued offline
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div className="cadence-row-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            style={{ width: 24, height: 24 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onBulkAction([t.id], 'archive');
                            }}
                            title="Archive"
                            aria-label={`Archive ${t.subject}`}
                          >
                            <Archive size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            style={{ width: 24, height: 24 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onBulkAction([t.id], isUnread ? 'mark_read' : 'mark_unread');
                            }}
                            title={isUnread ? 'Mark read' : 'Mark unread'}
                            aria-label={isUnread ? 'Mark read' : 'Mark unread'}
                          >
                            {isUnread ? <MailOpen size={13} /> : <Mail size={13} />}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            style={{ width: 24, height: 24 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (props.activeView === 'trash') {
                                setConfirmPermDeleteIds([t.id]);
                              } else {
                                props.onBulkAction([t.id], 'delete');
                              }
                            }}
                            title={props.activeView === 'trash' ? 'Delete permanently' : 'Delete'}
                            aria-label={`Delete ${t.subject}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        {t.hasAttachments && <Paperclip size={12} color="var(--text-muted)" />}
                        <span
                          className="tabular cadence-row-time"
                          style={{
                            fontSize: 11.5,
                            color: isUnread ? 'var(--accent)' : 'var(--text-muted)',
                            fontWeight: isUnread ? 600 : 400,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {formatRelativeDate(t.lastMessageAt, props.dateFormat, props.timeFormat)}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: isUnread ? 600 : 400,
                          color: isUnread ? 'var(--text-primary)' : 'var(--text-secondary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          maxWidth: '55%',
                        }}
                      >
                        {highlightText(t.subject, props.highlightTerms)}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          color: 'var(--text-muted)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          flex: 1,
                        }}
                      >
                        — {highlightText(t.snippet, props.highlightTerms)}
                      </span>
                      {t.labels.slice(0, 2).map((l) => (
                        <span
                          key={l.id}
                          className="chip cadence-desktop-only"
                          style={{
                            height: 18,
                            fontSize: 10.5,
                            background: `color-mix(in srgb, ${l.color} 14%, transparent)`,
                            color: l.color,
                          }}
                        >
                          {l.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {Boolean(props.onLoadMore) && typeof props.totalCount === 'number' && props.totalCount > 0 && props.threads.length < props.totalCount && (
          <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'center', borderTop: '1px solid var(--border-hairline)' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
            >
              {props.loadingMore
                ? 'Loading more conversations...'
                : `Load more (${props.totalCount - props.threads.length} remaining)`}
            </button>
          </div>
        )}
      </div>

      {/* Empty Trash / Spam Confirmation Modal */}
      {confirmEmptyFolder && props.onEmptyFolder && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm empty ${confirmEmptyFolder}`}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 95,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
          onClick={() => setConfirmEmptyFolder(null)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 400,
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-xl)',
              padding: 20,
              border: '1px solid var(--border-strong)',
              boxShadow: 'var(--shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15, color: 'var(--status-danger)' }}>
              Empty {confirmEmptyFolder === 'trash' ? 'Trash' : 'Spam'} permanently?
            </strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              All conversations and attachments currently in {confirmEmptyFolder === 'trash' ? 'Trash' : 'Spam'} will be permanently erased and cannot be recovered.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setConfirmEmptyFolder(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  const target = confirmEmptyFolder;
                  setConfirmEmptyFolder(null);
                  await props.onEmptyFolder!(target);
                }}
              >
                Empty {confirmEmptyFolder === 'trash' ? 'Trash' : 'Spam'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent Delete Confirmation Modal */}
      {confirmPermDeleteIds && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm permanent delete"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 95,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
          onClick={() => setConfirmPermDeleteIds(null)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 400,
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-xl)',
              padding: 20,
              border: '1px solid var(--border-strong)',
              boxShadow: 'var(--shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15, color: 'var(--status-danger)' }}>
              Permanently delete {confirmPermDeleteIds.length} conversation(s)?
            </strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Messages deleted permanently from Trash cannot be recovered.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setConfirmPermDeleteIds(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const targetIds = confirmPermDeleteIds;
                  setConfirmPermDeleteIds(null);
                  props.onBulkAction(targetIds, 'permanent_delete');
                }}
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-Click Context Menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            top: Math.min(contextMenu.y, window.innerHeight - 280),
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            width: 190,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            padding: 4,
            zIndex: 80,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {[
            { label: 'Reply', action: () => props.onReplyThread(contextMenu.thread.id, 'reply') },
            { label: 'Reply All', action: () => props.onReplyThread(contextMenu.thread.id, 'reply_all') },
            { label: 'Forward', action: () => props.onReplyThread(contextMenu.thread.id, 'forward') },
            {
              label: contextMenu.thread.unreadCount > 0 ? 'Mark as read' : 'Mark as unread',
              action: () =>
                props.onBulkAction([contextMenu.thread.id], contextMenu.thread.unreadCount > 0 ? 'mark_read' : 'mark_unread'),
            },
            {
              label: contextMenu.thread.isPinned ? 'Unpin' : 'Pin to top',
              action: () => props.onBulkAction([contextMenu.thread.id], contextMenu.thread.isPinned ? 'unpin' : 'pin'),
            },
            {
              label: 'Snooze until tomorrow 9 AM',
              action: () => {
                const d = new Date();
                d.setDate(d.getDate() + 1);
                d.setHours(9, 0, 0, 0);
                props.onBulkAction([contextMenu.thread.id], 'snooze', { snoozedUntil: d.toISOString() });
              },
            },
            { label: 'Archive', action: () => props.onBulkAction([contextMenu.thread.id], 'archive') },
            { label: 'Report spam', action: () => props.onBulkAction([contextMenu.thread.id], 'spam') },
            { label: 'Delete', action: () => props.onBulkAction([contextMenu.thread.id], 'delete') },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => {
                item.action();
                setContextMenu(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
