import React, { useState } from 'react';
import {
  AlertOctagon,
  Archive,
  BellRing,
  CalendarClock,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit3,
  FileText,
  Filter,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Layers,
  Mail,
  Paperclip,
  Plus,
  Send,
  Server,
  Settings,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  Account,
  ActiveWorkspaceSection,
  Category,
  Folder,
  Label,
  MailView,
  ViewCounts,
} from '../types';
import { AvatarBadge, CadenceMark } from './CadenceMark';

interface SidebarProps {
  accounts: Account[];
  selectedAccountId: string | 'all';
  onSelectAccount: (id: string | 'all') => void;
  activeSection: ActiveWorkspaceSection;
  onSelectSection: (s: ActiveWorkspaceSection) => void;
  activeView: MailView;
  activeFolderId: string | null;
  activeLabelId: string | null;
  activeCategory: string | null;
  onSelectMailView: (view: MailView, opts?: { folderId?: string; labelId?: string; category?: string }) => void;
  counts: ViewCounts;
  folders: Folder[];
  labels: Label[];
  categories: Category[];
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onCompose: () => void;
  onCreateFolder: (name: string, accountId: string, color: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onCreateLabel: (name: string, color: string) => Promise<void>;
  onDeleteLabel: (id: string) => Promise<void>;
  onDropThreadToFolder: (threadIds: string[], folderId: string) => void;
  onDropThreadToLabel: (threadIds: string[], labelId: string) => void;
  onConnectRealEmail: () => void;
  pendingReminderCount: number;
  openTaskCount?: number;
  isAdmin?: boolean;
}

const SWATCHES = ['#1D4ED8', '#047857', '#0F766E', '#D97706', '#7C3AED', '#DC2626', '#475569'];

export function Sidebar(props: SidebarProps) {
  const {
    accounts,
    selectedAccountId,
    onSelectAccount,
    activeSection,
    onSelectSection,
    activeView,
    activeFolderId,
    activeLabelId,
    activeCategory,
    onSelectMailView,
    counts,
    folders,
    labels,
    categories,
    collapsed,
    mobileOpen,
    onCloseMobile,
    onCompose,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onCreateLabel,
    onDeleteLabel,
    onDropThreadToFolder,
    onDropThreadToLabel,
    onConnectRealEmail,
    pendingReminderCount,
    openTaskCount = 0,
    isAdmin = false,
  } = props;

  const [expandFolders, setExpandFolders] = useState(false);
  const [expandLabels, setExpandLabels] = useState(false);
  const [expandCats, setExpandCats] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState(SWATCHES[0]);
  const [newLabelOpen, setNewLabelOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState(SWATCHES[1]);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');

  const customFolders = folders.filter(
    (f) => f.systemRole === 'custom' && (selectedAccountId === 'all' || f.accountId === selectedAccountId)
  );
  const favoriteFolders = customFolders.filter((f) => f.isFavorite);
  const enabledCategories = categories.filter((c) => c.enabled);

  const navItems: Array<{ id: MailView; label: string; icon: React.ReactNode; count?: number }> = [
    { id: 'inbox', label: 'Inbox', icon: <Inbox size={16} />, count: counts.inboxUnread },
    { id: 'priority', label: 'Priority', icon: <Sparkles size={16} />, count: counts.priorityUnread },
    { id: 'starred', label: 'Starred', icon: <Star size={16} />, count: counts.starred },
    { id: 'important', label: 'Important', icon: <AlertOctagon size={16} />, count: counts.important },
    { id: 'sent', label: 'Sent', icon: <Send size={16} /> },
    { id: 'drafts', label: 'Drafts', icon: <FileText size={16} />, count: counts.drafts },
    { id: 'snoozed', label: 'Snoozed', icon: <Clock size={16} />, count: counts.snoozed },
    { id: 'archive', label: 'Archive', icon: <Archive size={16} /> },
    { id: 'all', label: 'All Mail', icon: <Layers size={16} /> },
    { id: 'spam', label: 'Spam', icon: <AlertOctagon size={16} />, count: counts.spam },
    { id: 'trash', label: 'Trash', icon: <Trash2 size={16} />, count: counts.trash },
  ];

  function handleDrop(e: React.DragEvent, targetType: 'folder' | 'label', targetId: string) {
    e.preventDefault();
    setDragOverKey(null);
    const raw = e.dataTransfer.getData('application/cadence-threads');
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as string[];
      if (!Array.isArray(ids) || ids.length === 0) return;
      if (targetType === 'folder') onDropThreadToFolder(ids, targetId);
      else onDropThreadToLabel(ids, targetId);
    } catch {
      // ignore
    }
  }

  const sidebarBody = (
    <aside
      aria-label="Primary navigation"
      style={{
        width: collapsed ? 64 : 'var(--sidebar-width)',
        minWidth: collapsed ? 64 : 'var(--sidebar-width)',
        height: '100%',
        background: 'var(--bg-chrome)',
        borderRight: '1px solid var(--border-hairline)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width var(--duration-base) var(--ease-standard)',
      }}
    >
      {/* Brand header */}
      <div
        style={{
          height: 'var(--toolbar-height)',
          padding: collapsed ? '0 14px' : '0 14px 0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CadenceMark size={26} />
          {!collapsed && (
            <span style={{ fontWeight: 700, fontSize: 15.5, letterSpacing: '-0.02em' }}>Cadence</span>
          )}
        </div>
        {mobileOpen && (
          <button type="button" className="btn btn-ghost btn-icon cadence-mobile-only" onClick={onCloseMobile} aria-label="Close navigation">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Compose + Account Filter */}
      <div style={{ padding: collapsed ? '10px' : '12px 12px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCompose}
          style={{
            width: '100%',
            height: 38,
            justifyContent: collapsed ? 'center' : 'space-between',
            padding: collapsed ? 0 : '0 12px 0 14px',
            borderRadius: 'var(--radius-lg)',
          }}
          title="Compose new message (C)"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Edit3 size={15} />
            {!collapsed && <span>Compose</span>}
          </span>
          {!collapsed && (
            <span
              style={{
                fontSize: 10.5,
                padding: '1px 6px',
                borderRadius: 5,
                background: 'rgba(255,255,255,0.2)',
                color: '#fff',
                fontFamily: 'var(--font-mono)',
              }}
            >
              C
            </span>
          )}
        </button>

        {!collapsed && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: 4,
              borderRadius: 'var(--radius-lg)',
              background: 'color-mix(in srgb, var(--bg-subtle) 65%, transparent)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            {accounts.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{
                    justifyContent: 'space-between',
                    height: 28,
                    borderRadius: 'var(--radius-md)',
                    background: selectedAccountId === 'all' ? 'var(--bg-elevated)' : 'transparent',
                    boxShadow: selectedAccountId === 'all' ? 'var(--shadow-sm)' : 'none',
                    color: selectedAccountId === 'all' ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: selectedAccountId === 'all' ? 600 : 500,
                  }}
                  onClick={() => onSelectAccount('all')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Mail size={13} /> Unified Inbox
                  </span>
                  <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {accounts.reduce((a, b) => a + b.unreadCount, 0) || ''}
                  </span>
                </button>
                {accounts.map((acc) => {
                  const statusColor =
                    acc.status === 'connected'
                      ? 'var(--status-success)'
                      : acc.status === 'syncing'
                      ? 'var(--accent)'
                      : 'var(--status-danger)';
                  const ownershipLabel =
                    acc.accountOwnership === 'hosted' || acc.providerType === 'hosted' || acc.providerType === 'local'
                      ? 'Hosted'
                      : acc.providerType === 'imap_smtp'
                      ? 'IMAP'
                      : acc.providerType.charAt(0).toUpperCase() + acc.providerType.slice(1);
                  const isSel = selectedAccountId === acc.id;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{
                        justifyContent: 'space-between',
                        height: 36,
                        padding: '0 8px',
                        borderRadius: 'var(--radius-md)',
                        background: isSel ? 'var(--bg-elevated)' : 'transparent',
                        boxShadow: isSel ? 'var(--shadow-sm)' : 'none',
                        color: isSel ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: isSel ? 600 : 400,
                      }}
                      onClick={() => onSelectAccount(acc.id)}
                      title={`${acc.displayName} (${acc.emailAddress}) · ${ownershipLabel} · ${acc.status}`}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden', minWidth: 0 }}>
                        <AvatarBadge name={acc.displayName || acc.emailAddress} color={acc.avatarColor} size={20} />
                        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', overflow: 'hidden', minWidth: 0, lineHeight: 1.2 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, maxWidth: '100%', fontWeight: isSel ? 600 : 500 }}>
                            {acc.emailAddress}
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                            <span style={{ width: 5, height: 5, borderRadius: 99, background: statusColor }} />
                            {ownershipLabel}
                          </span>
                        </span>
                      </span>
                      {acc.unreadCount > 0 && (
                        <span className="tabular" style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>
                          {acc.unreadCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ justifyContent: 'flex-start', height: 27, color: 'var(--accent)', fontSize: 12, fontWeight: 500 }}
              onClick={onConnectRealEmail}
            >
              <Plus size={13} /> Connect Real Email
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Nav */}
      <div style={{ flex: 1, overflowY: 'auto', padding: collapsed ? '4px 8px' : '2px 10px 8px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {navItems.map((item) => {
            const isActive = activeSection === 'mail' && activeView === item.id && !activeCategory;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectSection('mail');
                  onSelectMailView(item.id);
                  onCloseMobile();
                }}
                title={item.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: collapsed ? 'center' : 'space-between',
                  height: 27,
                  padding: collapsed ? '0' : '0 10px',
                  borderRadius: 'var(--radius-md)',
                  border: 'none',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: isActive ? 600 : 500,
                  fontSize: 12.5,
                  transition: 'background var(--duration-fast) var(--ease-standard)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  {item.icon}
                  {!collapsed && <span>{item.label}</span>}
                </span>
                {!collapsed && item.count !== undefined && item.count > 0 && (
                  <span
                    className="tabular"
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '0 6px',
                      borderRadius: 99,
                      background: isActive ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--bg-badge)',
                      color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                    }}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Favorites */}
        {!collapsed && favoriteFolders.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', padding: '4px 10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Favorites
            </div>
            {favoriteFolders.map((f) => (
              <button
                key={`fav-${f.id}`}
                type="button"
                onClick={() => {
                  onSelectSection('mail');
                  onSelectMailView('folder', { folderId: f.id });
                  onCloseMobile();
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  height: 30,
                  padding: '0 10px',
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  background: activeView === 'folder' && activeFolderId === f.id ? 'var(--accent-soft)' : 'transparent',
                  color: 'var(--text-secondary)',
                  fontSize: 12.5,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <FolderIcon size={14} color={f.color} />
                  <span>{f.name}</span>
                </span>
                {f.unreadCount > 0 && <span className="tabular" style={{ fontSize: 11 }}>{f.unreadCount}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Categories */}
        {!collapsed && enabledCategories.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              onClick={() => setExpandCats((v) => !v)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 8px',
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {expandCats ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Categories
            </button>
            {expandCats &&
              enabledCategories.map((cat) => {
                const isActive = activeSection === 'mail' && activeView === 'inbox' && activeCategory === cat.slug;
                const catStat = counts.categories[cat.slug];
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      onSelectSection('mail');
                      onSelectMailView('inbox', { category: cat.slug });
                      onCloseMobile();
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      height: 29,
                      padding: '0 10px',
                      border: 'none',
                      borderRadius: 'var(--radius-md)',
                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: cat.color }} />
                      <span>{cat.name}</span>
                    </span>
                    {catStat?.unread ? (
                      <span className="tabular" style={{ fontSize: 11 }}>{catStat.unread}</span>
                    ) : null}
                  </button>
                );
              })}
          </div>
        )}

        {/* Custom Folders */}
        {!collapsed && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px' }}>
              <button
                type="button"
                onClick={() => setExpandFolders((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {expandFolders ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Folders
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 22, height: 22 }}
                onClick={() => setNewFolderOpen((v) => !v)}
                title="Create custom folder"
                aria-label="Create custom folder"
              >
                <FolderPlus size={13} />
              </button>
            </div>

            {newFolderOpen && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const acctId = selectedAccountId === 'all' ? accounts[0]?.id : selectedAccountId;
                  if (!acctId || !newFolderName.trim()) return;
                  await onCreateFolder(newFolderName.trim(), acctId, newFolderColor);
                  setNewFolderName('');
                  setNewFolderOpen(false);
                }}
                style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-hairline)', marginBottom: 6 }}
              >
                <input
                  className="field"
                  style={{ height: 28, fontSize: 12 }}
                  placeholder="Folder name"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  autoFocus
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewFolderColor(c)}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 99,
                          background: c,
                          border: newFolderColor === c ? '2px solid var(--text-primary)' : 'none',
                        }}
                        aria-label={`Color ${c}`}
                      />
                    ))}
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm" style={{ height: 24, fontSize: 11 }}>
                    Add
                  </button>
                </div>
              </form>
            )}

            {expandFolders &&
              customFolders.map((f) => {
                const isActive = activeSection === 'mail' && activeView === 'folder' && activeFolderId === f.id;
                const isDragOver = dragOverKey === `folder:${f.id}`;
                return (
                  <div
                    key={f.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverKey(`folder:${f.id}`);
                    }}
                    onDragLeave={() => setDragOverKey(null)}
                    onDrop={(e) => handleDrop(e, 'folder', f.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      height: 30,
                      padding: '0 8px',
                      borderRadius: 'var(--radius-md)',
                      background: isDragOver ? 'var(--accent-soft)' : isActive ? 'var(--accent-soft)' : 'transparent',
                      border: isDragOver ? '1px dashed var(--accent)' : '1px solid transparent',
                    }}
                  >
                    {editingFolderId === f.id ? (
                      <form
                        style={{ flex: 1, display: 'flex', gap: 4 }}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (editingFolderName.trim()) await onRenameFolder(f.id, editingFolderName.trim());
                          setEditingFolderId(null);
                        }}
                      >
                        <input
                          className="field"
                          style={{ height: 24, fontSize: 12, padding: '0 6px' }}
                          value={editingFolderName}
                          onChange={(e) => setEditingFolderName(e.target.value)}
                          onBlur={() => setEditingFolderId(null)}
                          autoFocus
                        />
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectSection('mail');
                            onSelectMailView('folder', { folderId: f.id });
                            onCloseMobile();
                          }}
                          onDoubleClick={() => {
                            setEditingFolderId(f.id);
                            setEditingFolderName(f.name);
                          }}
                          style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            border: 'none',
                            background: 'transparent',
                            color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                            fontSize: 12.5,
                            textAlign: 'left',
                            padding: 0,
                          }}
                        >
                          <FolderIcon size={14} color={f.color} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        </button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {f.unreadCount > 0 && <span className="tabular" style={{ fontSize: 11 }}>{f.unreadCount}</span>}
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            style={{ width: 20, height: 20 }}
                            onClick={() => onDeleteFolder(f.id)}
                            title="Delete folder"
                            aria-label={`Delete folder ${f.name}`}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            {expandFolders && customFolders.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: '2px 10px' }}>
                No custom folders yet
              </div>
            )}
          </div>
        )}

        {/* Labels */}
        {!collapsed && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px' }}>
              <button
                type="button"
                onClick={() => setExpandLabels((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {expandLabels ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Labels
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                style={{ width: 22, height: 22 }}
                onClick={() => setNewLabelOpen((v) => !v)}
                title="Create label"
                aria-label="Create label"
              >
                <Plus size={13} />
              </button>
            </div>

            {newLabelOpen && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newLabelName.trim()) return;
                  await onCreateLabel(newLabelName.trim(), newLabelColor);
                  setNewLabelName('');
                  setNewLabelOpen(false);
                }}
                style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-hairline)', marginBottom: 6 }}
              >
                <input
                  className="field"
                  style={{ height: 28, fontSize: 12 }}
                  placeholder="Label name"
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  autoFocus
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewLabelColor(c)}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 99,
                          background: c,
                          border: newLabelColor === c ? '2px solid var(--text-primary)' : 'none',
                        }}
                        aria-label={`Color ${c}`}
                      />
                    ))}
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm" style={{ height: 24, fontSize: 11 }}>
                    Add
                  </button>
                </div>
              </form>
            )}

            {expandLabels &&
              labels.map((l) => {
                const isActive = activeSection === 'mail' && activeView === 'label' && activeLabelId === l.id;
                const isDragOver = dragOverKey === `label:${l.id}`;
                return (
                  <div
                    key={l.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverKey(`label:${l.id}`);
                    }}
                    onDragLeave={() => setDragOverKey(null)}
                    onDrop={(e) => handleDrop(e, 'label', l.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      height: 29,
                      padding: '0 8px',
                      borderRadius: 'var(--radius-md)',
                      background: isDragOver ? 'var(--accent-soft)' : isActive ? 'var(--accent-soft)' : 'transparent',
                      border: isDragOver ? '1px dashed var(--accent)' : '1px solid transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelectSection('mail');
                        onSelectMailView('label', { labelId: l.id });
                        onCloseMobile();
                      }}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        border: 'none',
                        background: 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                        fontSize: 12.5,
                        textAlign: 'left',
                        padding: 0,
                      }}
                    >
                      <Tag size={13} color={l.color} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {l.threadCount > 0 && (
                        <span className="tabular" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {l.threadCount}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        style={{ width: 20, height: 20 }}
                        onClick={() => onDeleteLabel(l.id)}
                        title="Delete label"
                        aria-label={`Delete label ${l.name}`}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Bottom Workspace Links */}
      <div
        style={{
          padding: collapsed ? '6px' : '6px 8px 8px',
          borderTop: '1px solid var(--border-hairline)',
          display: 'grid',
          gridTemplateColumns: collapsed ? '1fr' : '1fr 1fr',
          gap: 3,
          background: 'color-mix(in srgb, var(--bg-subtle) 35%, transparent)',
        }}
      >
        {[
          {
            id: 'tasks' as const,
            label: 'Tasks',
            icon: <CheckSquare size={14} />,
            badge: openTaskCount,
          },
          { id: 'calendar' as const, label: 'Calendar', icon: <CalendarClock size={14} /> },
          { id: 'attachments' as const, label: 'Attachments', icon: <Paperclip size={14} /> },
          { id: 'collaboration' as const, label: 'Team Desk', icon: <Users size={14} /> },
          { id: 'contacts' as const, label: 'Contacts', icon: <Users size={14} /> },
          { id: 'rules' as const, label: 'Rules & Filters', icon: <Filter size={14} /> },
          { id: 'templates' as const, label: 'Templates', icon: <FileText size={14} /> },
          {
            id: 'reminders' as const,
            label: 'Reminders',
            icon: <BellRing size={14} />,
            badge: pendingReminderCount,
          },
          { id: 'settings' as const, label: 'Settings', icon: <Settings size={14} /> },
          ...(isAdmin
            ? [{ id: 'admin' as const, label: 'Administration', icon: <Server size={14} /> }]
            : []),
        ].map((item) => {
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectSection(item.id);
                onCloseMobile();
              }}
              title={item.label}
              aria-label={item.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: collapsed ? 'center' : 'space-between',
                height: 29,
                padding: collapsed ? 0 : '0 7px',
                border: isActive ? '1px solid color-mix(in srgb, var(--accent) 28%, transparent)' : '1px solid transparent',
                borderRadius: 'var(--radius-md)',
                background: isActive ? 'var(--bg-elevated)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: isActive ? 600 : 500,
                fontSize: 11.5,
                minWidth: 0,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden' }}>
                {item.icon}
                {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>}
              </span>
              {!collapsed && item.badge ? (
                <span className="chip tabular" style={{ height: 16, fontSize: 10, padding: '0 4px' }}>
                  {item.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );

  return (
    <>
      <div className="cadence-desktop-only" style={{ height: '100%' }}>
        {sidebarBody}
      </div>
      {mobileOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            background: 'rgba(0,0,0,0.45)',
          }}
          onClick={onCloseMobile}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ height: '100%' }}>
            {sidebarBody}
          </div>
        </div>
      )}
    </>
  );
}
