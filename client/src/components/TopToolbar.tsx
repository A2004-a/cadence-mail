import { useState } from 'react';
import {
  Bell,
  Columns,
  HelpCircle,
  LayoutList,
  Menu,
  Moon,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  WifiOff,
  X,
} from 'lucide-react';
import type { Account, NotificationItem, SavedSearch, UserPreferences } from '../types';
import { formatRelativeDate } from './CadenceMark';

interface TopToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  onAdvancedSearch: (filters: {
    from: string;
    to: string;
    subject: string;
    hasAttachment: boolean;
    after: string;
    before: string;
    isUnread: boolean;
  }) => void;
  searchHistory: Array<{ id: string; query: string }>;
  savedSearches?: SavedSearch[];
  onSaveSearch?: (name: string, query: string) => Promise<void>;
  onDeleteSavedSearch?: (id: string) => Promise<void>;
  onClearSearchHistory: () => void;
  isSyncing: boolean;
  onSyncNow: () => void;
  isOnline: boolean;
  pendingOfflineCount: number;
  onRetryOfflineQueue: () => void;
  layoutMode: UserPreferences['appearance']['layoutMode'];
  onChangeLayoutMode: (mode: UserPreferences['appearance']['layoutMode']) => void;
  theme: UserPreferences['appearance']['theme'];
  onToggleTheme: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebarCollapse: () => void;
  onOpenMobileDrawer: () => void;
  notifications: NotificationItem[];
  unreadNotifCount: number;
  onMarkAllNotifsRead: () => void;
  onSelectNotificationThread: (threadId: string, notifId: string) => void;
  aiPanelOpen: boolean;
  onToggleAiPanel: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  accounts: Account[];
  selectedAccountId: string | 'all';
  onSelectAccount: (id: string | 'all') => void;
}

const SEARCH_OPERATORS = [
  { token: 'from:', desc: 'Sender name or email' },
  { token: 'to:', desc: 'Recipient address' },
  { token: 'subject:', desc: 'Phrase in subject' },
  { token: 'has:attachment', desc: 'Only with attachments' },
  { token: 'filename:pdf', desc: 'Attachment filename' },
  { token: 'category:financial', desc: 'Inbox category' },
  { token: 'larger:1mb', desc: 'Minimum email size' },
  { token: 'is:unread', desc: 'Unread conversations' },
  { token: 'is:starred', desc: 'Starred conversations' },
  { token: 'before:2026-12-01', desc: 'Sent before date' },
  { token: 'after:2026-01-01', desc: 'Sent after date' },
];

export function TopToolbar(props: TopToolbarProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const [advFrom, setAdvFrom] = useState('');
  const [advTo, setAdvTo] = useState('');
  const [advSubject, setAdvSubject] = useState('');
  const [advHasAtt, setAdvHasAtt] = useState(false);
  const [advAfter, setAdvAfter] = useState('');
  const [advBefore, setAdvBefore] = useState('');
  const [advUnread, setAdvUnread] = useState(false);

  return (
    <header
      className="no-print"
      style={{
        height: 'var(--toolbar-height)',
        background: 'var(--bg-chrome)',
        borderBottom: '1px solid var(--border-hairline)',
        padding: '0 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        position: 'relative',
        zIndex: 30,
      }}
    >
      {/* Left: Drawer / Sidebar toggle + Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        <button
          type="button"
          className="btn btn-ghost btn-icon cadence-mobile-only"
          onClick={props.onOpenMobileDrawer}
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon cadence-desktop-only"
          onClick={props.onToggleSidebarCollapse}
          title={props.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={props.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {props.sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>

        {/* Global Search Box */}
        <div style={{ position: 'relative', flex: 1, maxWidth: 580 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearchFocused(false);
              props.onSearchSubmit(props.searchQuery);
            }}
            style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
          >
            <Search
              size={15}
              style={{ position: 'absolute', left: 12, color: searchFocused ? 'var(--accent)' : 'var(--text-muted)', pointerEvents: 'none', transition: 'color var(--duration-fast)' }}
            />
            <input
              id="cadence-global-search"
              type="search"
              className="field"
              style={{
                paddingLeft: 36,
                paddingRight: 78,
                height: 36,
                borderRadius: 'var(--radius-pill)',
                background: searchFocused ? 'var(--bg-canvas)' : 'var(--bg-subtle)',
                borderColor: searchFocused ? 'var(--accent)' : 'transparent',
                fontSize: 13,
              }}
              placeholder="Search mail (from:, has:attachment, is:unread...)"
              value={props.searchQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 180)}
              onChange={(e) => props.onSearchChange(e.target.value)}
            />
            <div style={{ position: 'absolute', right: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              {!props.searchQuery && !searchFocused && (
                <span className="kbd cadence-desktop-only" style={{ fontSize: 10, height: 18, minWidth: 18 }}>/</span>
              )}
              {props.searchQuery && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ width: 24, height: 24, borderRadius: 99 }}
                  onClick={() => {
                    props.onSearchChange('');
                    props.onSearchSubmit('');
                  }}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 26, height: 26, borderRadius: 99 }}
                onClick={() => setAdvOpen((v) => !v)}
                title="Advanced search filters"
                aria-label="Advanced search filters"
              >
                <SlidersHorizontal size={14} />
              </button>
            </div>
          </form>

          {/* Search Suggestions & Recent History */}
          {searchFocused && !advOpen && (
            <div
              style={{
                position: 'absolute',
                top: 38,
                left: 0,
                right: 0,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                padding: 12,
                zIndex: 50,
              }}
            >
              {props.searchHistory.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      Recent searches
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ height: 22, fontSize: 11 }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        props.onClearSearchHistory();
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {props.searchHistory.slice(0, 6).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="chip"
                        style={{ cursor: 'pointer' }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          props.onSearchChange(item.query);
                          props.onSearchSubmit(item.query);
                          setSearchFocused(false);
                        }}
                      >
                        {item.query}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {props.savedSearches && (props.savedSearches.length > 0 || props.searchQuery.trim()) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      Saved searches
                    </span>
                    {props.searchQuery.trim() && props.onSaveSearch && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ height: 22, fontSize: 11 }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          const q = props.searchQuery.trim();
                          void props.onSaveSearch!(q.slice(0, 32), q);
                        }}
                      >
                        + Save current query
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {props.savedSearches.map((s) => (
                      <span key={s.id} className="chip" style={{ gap: 6 }}>
                        <button
                          type="button"
                          style={{ border: 'none', background: 'transparent', padding: 0, color: 'inherit', cursor: 'pointer', fontSize: 11.5 }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            props.onSearchChange(s.query);
                            props.onSearchSubmit(s.query);
                            setSearchFocused(false);
                          }}
                        >
                          {s.name}
                        </button>
                        {props.onDeleteSavedSearch && (
                          <button
                            type="button"
                            style={{ border: 'none', background: 'transparent', padding: 0, color: 'inherit', cursor: 'pointer', display: 'inline-flex' }}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              void props.onDeleteSavedSearch!(s.id);
                            }}
                            aria-label={`Delete saved search ${s.name}`}
                          >
                            <X size={11} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                Search operators
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 4 }}>
                {SEARCH_OPERATORS.map((op) => (
                  <button
                    key={op.token}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ justifyContent: 'space-between', height: 26, fontSize: 12 }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const next = props.searchQuery ? `${props.searchQuery.trim()} ${op.token}` : op.token;
                      props.onSearchChange(next);
                    }}
                  >
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--accent)' }}>{op.token}</code>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{op.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Advanced Search Panel */}
          {advOpen && (
            <div
              style={{
                position: 'absolute',
                top: 38,
                left: 0,
                right: 0,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                padding: 16,
                zIndex: 55,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 13.5 }}>Advanced Search</strong>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setAdvOpen(false)} aria-label="Close">
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>From</label>
                  <input className="field" style={{ height: 30, marginTop: 3 }} value={advFrom} onChange={(e) => setAdvFrom(e.target.value)} placeholder="sender@domain.com" />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>To</label>
                  <input className="field" style={{ height: 30, marginTop: 3 }} value={advTo} onChange={(e) => setAdvTo(e.target.value)} placeholder="recipient@domain.com" />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Subject contains</label>
                  <input className="field" style={{ height: 30, marginTop: 3 }} value={advSubject} onChange={(e) => setAdvSubject(e.target.value)} placeholder="Quarterly report..." />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>After date</label>
                  <input type="date" className="field" style={{ height: 30, marginTop: 3 }} value={advAfter} onChange={(e) => setAdvAfter(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Before date</label>
                  <input type="date" className="field" style={{ height: 30, marginTop: 3 }} value={advBefore} onChange={(e) => setAdvBefore(e.target.value)} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={advHasAtt} onChange={(e) => setAdvHasAtt(e.target.checked)} />
                  Has attachment
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={advUnread} onChange={(e) => setAdvUnread(e.target.checked)} />
                  Unread only
                </label>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setAdvFrom('');
                    setAdvTo('');
                    setAdvSubject('');
                    setAdvHasAtt(false);
                    setAdvAfter('');
                    setAdvBefore('');
                    setAdvUnread(false);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setAdvOpen(false);
                    props.onAdvancedSearch({
                      from: advFrom,
                      to: advTo,
                      subject: advSubject,
                      hasAttachment: advHasAtt,
                      after: advAfter,
                      before: advBefore,
                      isUnread: advUnread,
                    });
                  }}
                >
                  Search Mail
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right: Sync, Offline Status, Layout, Theme, Notifications, AI, Account, Settings */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {(!props.isOnline || props.pendingOfflineCount > 0) && (
          <button
            type="button"
            className="btn btn-sm"
            style={{
              background: 'var(--status-warning-bg)',
              color: 'var(--status-warning)',
              borderColor: 'color-mix(in srgb, var(--status-warning) 35%, transparent)',
            }}
            onClick={props.onRetryOfflineQueue}
            title="Pending offline changes waiting to synchronize"
          >
            <WifiOff size={13} />
            <span className="tabular">
              {!props.isOnline ? 'Offline' : `Syncing ${props.pendingOfflineCount} queued`}
            </span>
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={props.onSyncNow}
          disabled={props.isSyncing}
          title="Synchronize accounts"
          aria-label="Synchronize accounts"
        >
          <RefreshCw size={16} style={{ animation: props.isSyncing ? 'spin 1s linear infinite' : undefined }} />
        </button>

        {/* Layout Mode Selector */}
        <div
          className="cadence-desktop-only"
          style={{
            display: 'flex',
            alignItems: 'center',
            background: 'var(--bg-subtle)',
            padding: 2,
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{
              width: 26,
              height: 26,
              background: props.layoutMode === 'list' ? 'var(--bg-elevated)' : 'transparent',
            }}
            onClick={() => props.onChangeLayoutMode('list')}
            title="List view"
            aria-label="List view"
          >
            <LayoutList size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{
              width: 26,
              height: 26,
              background: props.layoutMode === 'split-right' ? 'var(--bg-elevated)' : 'transparent',
            }}
            onClick={() => props.onChangeLayoutMode('split-right')}
            title="Split right reading pane"
            aria-label="Split right reading pane"
          >
            <Columns size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{
              width: 26,
              height: 26,
              background: props.layoutMode === 'split-bottom' ? 'var(--bg-elevated)' : 'transparent',
            }}
            onClick={() => props.onChangeLayoutMode('split-bottom')}
            title="Split bottom reading pane"
            aria-label="Split bottom reading pane"
          >
            <PanelBottom size={14} />
          </button>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-icon cadence-hide-xs"
          onClick={props.onToggleTheme}
          title={`Theme: ${props.theme}`}
          aria-label="Toggle color theme"
        >
          {props.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* Notifications */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setNotifOpen((v) => !v)}
            title="Notifications"
            aria-label="Notifications"
          >
            <Bell size={16} />
            {props.unreadNotifCount > 0 && (
              <span
                className="tabular"
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 99,
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {props.unreadNotifCount}
              </span>
            )}
          </button>

          {notifOpen && (
            <div
              style={{
                position: 'absolute',
                top: 38,
                right: 0,
                width: 340,
                maxHeight: 420,
                overflowY: 'auto',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 60,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
                <strong style={{ fontSize: 13 }}>Notifications</strong>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => props.onMarkAllNotifsRead()}
                >
                  Mark all read
                </button>
              </div>
              {props.notifications.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                  No notifications yet
                </div>
              ) : (
                props.notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      if (n.threadId) props.onSelectNotificationThread(n.threadId, n.id);
                      setNotifOpen(false);
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 14px',
                      border: 'none',
                      borderBottom: '1px solid var(--border-hairline)',
                      background: n.isRead ? 'transparent' : 'var(--accent-soft)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 600 }}>
                      <span>{n.title}</span>
                      <span className="tabular" style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
                        {formatRelativeDate(n.createdAt)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{n.body}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* AI Assistant Toggle */}
        <button
          type="button"
          className={`btn btn-sm ${props.aiPanelOpen ? 'btn-primary' : ''}`}
          onClick={props.onToggleAiPanel}
          title="Open AI Correspondence Assistant"
        >
          <Sparkles size={14} />
          <span className="cadence-desktop-only">Assistant</span>
        </button>

        {/* Account quick selector */}
        {props.accounts.length > 1 && (
          <select
            aria-label="Active account filter"
            className="field cadence-desktop-only"
            style={{ width: 'auto', maxWidth: 165, height: 32, fontSize: 12 }}
            value={props.selectedAccountId}
            onChange={(e) => props.onSelectAccount(e.target.value)}
          >
            <option value="all">All Accounts</option>
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emailAddress}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-icon cadence-hide-xs"
          onClick={props.onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <HelpCircle size={16} />
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={props.onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}
