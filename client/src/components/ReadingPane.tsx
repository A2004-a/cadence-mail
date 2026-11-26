import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  AlertOctagon,
  Archive,
  ArrowLeft,
  BellPlus,
  CalendarClock,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Filter,
  FolderInput,
  Forward,
  Image as ImageIcon,
  Mail,
  MailCheck,
  MailOpen,
  Maximize2,
  Paperclip,
  Pin,
  Printer,
  Reply,
  ReplyAll,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  Trash2,
  UserX,
  X,
} from 'lucide-react';
import type { Account, Category, EmailMessage, Folder, Label, ThreadSummary, UserPreferences } from '../types';
import { AvatarBadge, formatBytes, formatFullTimestamp } from './CadenceMark';

let purifyHookInstalled = false;
if (!purifyHookInstalled && typeof window !== 'undefined') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  purifyHookInstalled = true;
}

const POPOVER_MENU_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 34,
  left: 0,
  minWidth: 204,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-lg)',
  padding: 6,
  zIndex: 50,
};

const TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToParagraphHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isPreviewableTextMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return (
    lower === 'text/plain' ||
    lower === 'text/csv' ||
    lower === 'text/markdown' ||
    lower === 'application/json'
  );
}

function isHostedAccount(account: Account): boolean {
  return account.providerType === 'local' || account.providerType === 'hosted' || account.accountOwnership === 'hosted';
}

function buildSnoozeTime(preset: 'later_today' | 'tomorrow' | 'next_week'): string {
  const d = new Date();
  if (preset === 'later_today') {
    d.setHours(d.getHours() + 3);
  } else if (preset === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 7);
    d.setHours(9, 0, 0, 0);
  }
  return d.toISOString();
}

function formatAuthTooltip(m: EmailMessage): string {
  if (!m.authResults) return 'Authenticated (SPF/DKIM/DMARC)';
  const parts: string[] = [];
  if (m.authResults.spf) parts.push(`SPF: ${m.authResults.spf}`);
  if (m.authResults.dkim) parts.push(`DKIM: ${m.authResults.dkim}`);
  if (m.authResults.dmarc) parts.push(`DMARC: ${m.authResults.dmarc}`);
  return parts.length > 0 ? parts.join(' · ') : 'Authenticated (SPF/DKIM/DMARC)';
}

interface ReadingPaneProps {
  thread: ThreadSummary | null;
  account?: Account | null;
  messages: EmailMessage[];
  loading: boolean;
  folders: Folder[];
  labels: Label[];
  categories?: Category[];
  preferences: UserPreferences;
  onBackToList?: () => void;
  onReply: (msg: EmailMessage, mode: 'reply' | 'reply_all' | 'forward', prefillBodyHtml?: string) => void;
  onQuickReplySend?: (msg: EmailMessage, mode: 'reply' | 'reply_all', text: string) => Promise<void>;
  onBulkAction: (
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
      | 'spam'
      | 'snooze'
      | 'unsnooze'
      | 'move_folder'
      | 'add_label'
      | 'remove_label'
      | 'categorize'
      | 'pin'
      | 'unpin',
    extra?: { snoozedUntil?: string; folderId?: string; labelId?: string; categorySlug?: string }
  ) => void;
  onReportPhishing: (threadId: string, blockSender: boolean) => void;
  onBlockSender: (email: string) => void;
  onCreateReminder: (threadId: string, messageId: string, title: string, dueAt: string) => Promise<void>;
  onCreateTask?: (threadId: string, messageId: string, title: string, dueAt: string | null) => Promise<void>;
  onExtractEvent?: (threadId: string) => Promise<{
    title: string;
    description: string;
    location: string;
    meetingUrl: string;
    startAt: string;
    endAt: string;
    attendees: Array<{ name: string; address: string }>;
  }>;
  onSaveEvent?: (payload: {
    accountId?: string | null;
    threadId: string;
    messageId?: string | null;
    title: string;
    description: string;
    location: string;
    meetingUrl: string;
    startAt: string;
    endAt: string;
    attendees: Array<{ name: string; address: string }>;
    source: 'extracted';
  }) => Promise<void>;
  onCreateRuleFromSender?: (fromAddress: string, subject: string) => void;
  onUnsubscribeMailto?: (mailtoAddress: string, subject: string) => void;
  onOpenAiForThread: () => void;
  hasThreads?: boolean;
  accounts?: Account[];
  onCompose?: () => void;
  onConnectRealEmail?: () => void;
  onOpenShortcuts?: () => void;
}

function ReadingPaneEmptyState({
  hasThreads,
  accounts,
  onCompose,
  onConnectRealEmail,
  onOpenShortcuts,
}: {
  hasThreads?: boolean;
  accounts: Account[];
  onCompose?: () => void;
  onConnectRealEmail?: () => void;
  onOpenShortcuts?: () => void;
}) {
  const hasConnectedExternal = accounts.some((a) => !isHostedAccount(a));

  if (!hasThreads) {
    return (
      <div
        style={{
          height: '100%',
          overflowY: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 28px',
          background: 'radial-gradient(circle at 50% 0%, var(--accent-soft), transparent 62%), var(--bg-canvas)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 600 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '5px 12px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                boxShadow: 'var(--shadow-xs)',
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: 14,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--status-success)' }} />
              <span>Workspace Command Center</span>
            </div>
            <h2
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '-0.025em',
                color: 'var(--text-primary)',
              }}
            >
              Your mail workspace is ready
            </h2>
            <p
              style={{
                margin: '8px auto 0',
                maxWidth: 440,
                fontSize: 13.5,
                lineHeight: 1.55,
                color: 'var(--text-muted)',
              }}
            >
              Send and receive on your own domain infrastructure or unify external accounts with instant local search.
            </p>
          </div>

          {accounts.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: 8,
                marginBottom: 20,
              }}
            >
              {accounts.slice(0, 4).map((acc) => (
                <div
                  key={acc.id}
                  className="chip"
                  style={{
                    height: 28,
                    padding: '0 10px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    gap: 7,
                    fontSize: 12,
                    color: 'var(--text-primary)',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 99,
                      background:
                        acc.status === 'error' || acc.status === 'auth_expired'
                          ? 'var(--status-danger)'
                          : acc.status === 'disconnected' || acc.status === 'suspended'
                            ? 'var(--status-warning)'
                            : 'var(--status-success)',
                    }}
                  />
                  <span style={{ fontWeight: 500 }}>{acc.emailAddress}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                    {isHostedAccount(acc) ? 'Hosted' : acc.providerType}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 12,
            }}
          >
            {onConnectRealEmail && (
              <button
                type="button"
                onClick={onConnectRealEmail}
                className="cadence-hub-card"
                style={{
                  textAlign: 'left',
                  padding: 16,
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-sm)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Mail size={16} />
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>{hasConnectedExternal ? 'Add Mailbox' : 'Connect Mailbox'}</span>
                  <ChevronRight size={14} color="var(--text-muted)" />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Gmail, Outlook, Yahoo, or custom IMAP/SMTP.
                </div>
              </button>
            )}

            {onCompose && (
              <button
                type="button"
                onClick={onCompose}
                className="cadence-hub-card"
                style={{
                  textAlign: 'left',
                  padding: 16,
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-sm)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--status-info-bg)',
                      color: 'var(--status-info)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Send size={15} />
                  </div>
                  <span className="kbd">c</span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>New Message</span>
                  <ChevronRight size={14} color="var(--text-muted)" />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Draft emails with scheduling, templates & AI assist.
                </div>
              </button>
            )}

            {onOpenShortcuts && (
              <button
                type="button"
                onClick={onOpenShortcuts}
                className="cadence-hub-card"
                style={{
                  textAlign: 'left',
                  padding: 16,
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-sm)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-subtle)',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Sparkles size={15} />
                  </div>
                  <span className="kbd">?</span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Command Keys</span>
                  <ChevronRight size={14} color="var(--text-muted)" />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Triage fast using J / K navigation & quick actions.
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        color: 'var(--text-muted)',
        textAlign: 'center',
        background: 'radial-gradient(circle at 50% 0%, var(--accent-soft), transparent 55%), var(--bg-canvas)',
      }}
    >
      <div
        className="cadence-hub-card"
        style={{
          padding: '28px 32px',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
          maxWidth: 360,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-subtle)',
            color: 'var(--text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 12,
          }}
        >
          <MailCheck size={22} />
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 700, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>
          Select a conversation
        </div>
        <p style={{ fontSize: 13, maxWidth: 300, margin: '6px auto 14px', lineHeight: 1.5 }}>
          Choose a thread from the list or press <span className="kbd">j</span> / <span className="kbd">k</span> to move through your inbox.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <span><span className="kbd">c</span> Compose</span>
          <span><span className="kbd">e</span> Archive</span>
          <span><span className="kbd">r</span> Reply</span>
        </div>
      </div>
    </div>
  );
}

export function ReadingPane(props: ReadingPaneProps) {
  const { thread, messages } = props;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [revealedImagesMsgIds, setRevealedImagesMsgIds] = useState<Set<string>>(new Set());
  const [activeMenu, setActiveMenu] = useState<'snooze' | 'labels' | 'folders' | null>(null);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderDue, setReminderDue] = useState('');
  const [reminderSaving, setReminderSaving] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [taskSaving, setTaskSaving] = useState(false);
  const [eventDraft, setEventDraft] = useState<{
    title: string;
    description: string;
    location: string;
    meetingUrl: string;
    startAt: string;
    endAt: string;
    attendees: Array<{ name: string; address: string }>;
  } | null>(null);
  const [extractingEvent, setExtractingEvent] = useState(false);
  const [savingEvent, setSavingEvent] = useState(false);
  const [previewAtt, setPreviewAtt] = useState<{ id: string; filename: string; mimeType: string } | null>(null);
  const [previewText, setPreviewText] = useState<{ loading: boolean; content: string | null; truncated: boolean; error: string | null }>({
    loading: false,
    content: null,
    truncated: false,
    error: null,
  });
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [quickReplyMode, setQuickReplyMode] = useState<'reply' | 'reply_all'>(props.preferences.email.defaultReplyBehavior || 'reply');
  const [quickReplyText, setQuickReplyText] = useState('');
  const [quickReplySending, setQuickReplySending] = useState(false);
  const [quickReplyError, setQuickReplyError] = useState<string | null>(null);
  const [confirmBlockEmail, setConfirmBlockEmail] = useState<string | null>(null);
  const [confirmUnsub, setConfirmUnsub] = useState<{ from: string; httpUrl?: string; mailto?: string } | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const msgRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const toolbarMenusRef = useRef<HTMLDivElement | null>(null);
  const reminderFormRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    setQuickReplyMode(props.preferences.email.defaultReplyBehavior || 'reply');
  }, [props.preferences.email.defaultReplyBehavior]);

  useEffect(() => {
    if (messages.length > 0) {
      const initial = new Set<string>();
      messages.forEach((m, idx) => {
        if (!m.isRead || idx === messages.length - 1) initial.add(m.id);
      });
      setExpandedIds(initial);
      setRevealedImagesMsgIds(new Set());
      setActiveMenu(null);
      setReminderOpen(false);
      setReminderError(null);
      setTaskOpen(false);
      setEventDraft(null);
      setQuickReplyOpen(false);
      setQuickReplyText('');
      setQuickReplyError(null);
      setConfirmBlockEmail(null);
      setPreviewAtt(null);
    }
  }, [thread?.id, messages.length]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (activeMenu && toolbarMenusRef.current && !toolbarMenusRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (previewAtt) {
        setPreviewAtt(null);
      } else if (confirmBlockEmail) {
        setConfirmBlockEmail(null);
      } else if (activeMenu) {
        setActiveMenu(null);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [activeMenu, previewAtt, confirmBlockEmail]);

  useEffect(() => {
    if (!previewAtt || previewAtt.mimeType.startsWith('image/')) {
      setPreviewText({ loading: false, content: null, truncated: false, error: null });
      return;
    }

    const controller = new AbortController();
    setPreviewText({ loading: true, content: null, truncated: false, error: null });

    fetch(`/api/v1/threads/attachments/${previewAtt.id}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const truncated = text.length > TEXT_PREVIEW_LIMIT_BYTES;
        setPreviewText({
          loading: false,
          content: truncated ? text.slice(0, TEXT_PREVIEW_LIMIT_BYTES) : text,
          truncated,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPreviewText({
          loading: false,
          content: null,
          truncated: false,
          error: 'Could not load inline preview. Use Download to open this file.',
        });
      });

    return () => controller.abort();
  }, [previewAtt]);

  const sanitizedBodiesById = useMemo(() => {
    const out: Record<string, string> = {};
    const loadExternal = props.preferences.email.loadExternalImages;
    for (const m of messages) {
      const showImages =
        loadExternal === 'always' || (loadExternal !== 'never' && revealedImagesMsgIds.has(m.id));
      let raw =
        m.bodyHtmlSanitized ||
        `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(m.bodyText || '')}</pre>`;
      if (showImages) {
        raw = raw.replace(/<img\b([^>]*?)data-blocked-src="([^"]+)"([^>]*?)>/gi, (_full, pre, src, post) => {
          const cleanedPre = pre.replace(/\bsrc="[^"]*"/gi, '');
          const cleanedPost = post.replace(/\bsrc="[^"]*"/gi, '');
          return `<img ${cleanedPre} src="${src}" ${cleanedPost}>`;
        });
      }
      out[m.id] = DOMPurify.sanitize(raw, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
        ADD_ATTR: ['data-blocked-src', 'target', 'rel'],
      });
    }
    return out;
  }, [messages, revealedImagesMsgIds, props.preferences.email.loadExternalImages]);

  const threadLabelIds = useMemo(() => new Set((thread?.labels || []).map((l) => l.id)), [thread]);

  if (props.loading) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="skeleton" style={{ height: 24, width: '60%' }} />
        <div className="skeleton" style={{ height: 14, width: '35%' }} />
        <div className="skeleton" style={{ height: 180, width: '100%' }} />
      </div>
    );
  }

  if (!thread) {
    return (
      <ReadingPaneEmptyState
        hasThreads={props.hasThreads}
        accounts={props.accounts || []}
        onCompose={props.onCompose}
        onConnectRealEmail={props.onConnectRealEmail}
        onOpenShortcuts={props.onOpenShortcuts}
      />
    );
  }

  const latestMsg = messages[messages.length - 1];
  const accountFolders = props.folders.filter((f) => f.accountId === thread.accountId);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCopyAddress(address: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(address).then(() => {
      setCopiedAddr(address);
      setTimeout(() => {
        setCopiedAddr((cur) => (cur === address ? null : cur));
      }, 1500);
    });
  }

  async function submitQuickReply() {
    if (!latestMsg || !props.onQuickReplySend || !quickReplyText.trim() || quickReplySending) return;
    setQuickReplySending(true);
    setQuickReplyError(null);
    try {
      await props.onQuickReplySend(latestMsg, quickReplyMode, quickReplyText);
      setQuickReplyText('');
      setQuickReplyOpen(false);
    } catch (err) {
      setQuickReplyError(err instanceof Error ? err.message : 'Failed to send reply. Please try again.');
    } finally {
      setQuickReplySending(false);
    }
  }

  return (
    <article
      aria-label="Conversation reader"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-canvas)',
        overflow: 'hidden',
      }}
    >
      {/* Top Action Bar */}
      <div
        className="no-print"
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-hairline)',
          background: 'var(--bg-canvas)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div ref={toolbarMenusRef} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {props.onBackToList && (
            <button type="button" className="btn btn-ghost btn-icon" onClick={props.onBackToList} title="Back to list" aria-label="Back to list">
              <ArrowLeft size={16} />
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => props.onBulkAction('archive')} title="Archive (E)" aria-label="Archive">
            <Archive size={16} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => props.onBulkAction('delete')} title="Delete (#)" aria-label="Delete">
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => props.onBulkAction(thread.unreadCount > 0 ? 'mark_read' : 'mark_unread')}
            title={thread.unreadCount > 0 ? 'Mark read' : 'Mark unread'}
            aria-label={thread.unreadCount > 0 ? 'Mark read' : 'Mark unread'}
          >
            {thread.unreadCount > 0 ? <MailOpen size={16} /> : <Mail size={16} />}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => props.onBulkAction(thread.isStarred ? 'unstar' : 'star')}
            title={thread.isStarred ? 'Remove star (S)' : 'Star (S)'}
            aria-label="Toggle star"
          >
            <Star size={16} fill={thread.isStarred ? '#F59E0B' : 'none'} color={thread.isStarred ? '#F59E0B' : 'currentColor'} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => props.onBulkAction(thread.isPinned ? 'unpin' : 'pin')}
            title={thread.isPinned ? 'Unpin' : 'Pin thread'}
            aria-label="Toggle pin"
          >
            <Pin size={16} color={thread.isPinned ? 'var(--accent)' : 'currentColor'} />
          </button>

          {/* Snooze Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setActiveMenu((cur) => (cur === 'snooze' ? null : 'snooze'))}
              title="Snooze"
              aria-label="Snooze conversation"
              aria-expanded={activeMenu === 'snooze'}
              aria-haspopup="menu"
            >
              <Clock size={16} color={thread.snoozedUntil ? 'var(--accent)' : 'currentColor'} />
            </button>
            {activeMenu === 'snooze' && (
              <div role="menu" aria-label="Snooze options" style={{ ...POPOVER_MENU_STYLE, width: 210 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', padding: '4px 8px' }}>Snooze until</div>
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => {
                    props.onBulkAction('snooze', { snoozedUntil: buildSnoozeTime('later_today') });
                    setActiveMenu(null);
                  }}
                >
                  Later today (+3h)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => {
                    props.onBulkAction('snooze', { snoozedUntil: buildSnoozeTime('tomorrow') });
                    setActiveMenu(null);
                  }}
                >
                  Tomorrow, 9:00 AM
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => {
                    props.onBulkAction('snooze', { snoozedUntil: buildSnoozeTime('next_week') });
                    setActiveMenu(null);
                  }}
                >
                  Next week
                </button>
                {thread.snoozedUntil && (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost btn-sm"
                    style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--accent)' }}
                    onClick={() => {
                      props.onBulkAction('unsnooze');
                      setActiveMenu(null);
                    }}
                  >
                    Unsnooze now
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Label Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setActiveMenu((cur) => (cur === 'labels' ? null : 'labels'))}
              title="Labels"
              aria-label="Manage labels"
              aria-expanded={activeMenu === 'labels'}
              aria-haspopup="menu"
            >
              <Tag size={16} />
            </button>
            {activeMenu === 'labels' && (
              <div role="menu" aria-label="Labels" style={{ ...POPOVER_MENU_STYLE, width: 200 }}>
                {props.labels.map((l) => {
                  const has = threadLabelIds.has(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={has}
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', justifyContent: 'space-between' }}
                      onClick={() => props.onBulkAction(has ? 'remove_label' : 'add_label', { labelId: l.id })}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: l.color }} />
                        {l.name}
                      </span>
                      {has && <Check size={13} color="var(--accent)" />}
                    </button>
                  );
                })}
                {props.labels.length === 0 && <div style={{ fontSize: 12, padding: 8, color: 'var(--text-muted)' }}>No labels yet</div>}
                {props.account && !props.account.capabilities?.supportsLabels && (
                  <div style={{ fontSize: 10.5, padding: '6px 8px 2px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-hairline)', marginTop: 4 }}>
                    Stored locally in Cadence (provider uses folders)
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Folder Move Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setActiveMenu((cur) => (cur === 'folders' ? null : 'folders'))}
              title="Move to folder"
              aria-label="Move to folder"
              aria-expanded={activeMenu === 'folders'}
              aria-haspopup="menu"
            >
              <FolderInput size={16} />
            </button>
            {activeMenu === 'folders' && (
              <div role="menu" aria-label="Move to folder" style={{ ...POPOVER_MENU_STYLE, width: 196 }}>
                {accountFolders.length > 0 ? (
                  accountFolders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="menuitem"
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                      onClick={() => {
                        props.onBulkAction('move_folder', { folderId: f.id });
                        setActiveMenu(null);
                      }}
                    >
                      {f.name}
                    </button>
                  ))
                ) : (
                  <div style={{ fontSize: 12, padding: 8, color: 'var(--text-muted)' }}>No folders available</div>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => props.onReportPhishing(thread.id, false)}
            title="Report phishing / spam"
            aria-label="Report phishing"
          >
            <AlertOctagon size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {props.onCreateTask && latestMsg && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Convert thread to task"
              onClick={() => {
                setTaskTitle(thread.subject.replace(/^(?:re|fwd|fw):\s*/i, '').trim() || thread.subject);
                setTaskDue(toLocalDateTimeInputValue(new Date(Date.now() + 86_400_000)));
                setTaskOpen((prev) => !prev);
              }}
            >
              <CheckSquare size={13} />
              Task
            </button>
          )}
          {props.onExtractEvent && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Extract meeting / event from email"
              disabled={extractingEvent}
              onClick={async () => {
                if (!props.onExtractEvent) return;
                setExtractingEvent(true);
                try {
                  const candidate = await props.onExtractEvent(thread.id);
                  setEventDraft({
                    ...candidate,
                    startAt: toLocalDateTimeInputValue(new Date(candidate.startAt)),
                    endAt: toLocalDateTimeInputValue(new Date(candidate.endAt)),
                  });
                } finally {
                  setExtractingEvent(false);
                }
              }}
            >
              <CalendarClock size={13} />
              {extractingEvent ? 'Extracting...' : 'Event'}
            </button>
          )}
          {(props.onCreateTask || props.onExtractEvent) && (
            <span aria-hidden="true" style={{ width: 1, height: 18, background: 'var(--border-hairline)', margin: '0 2px' }} />
          )}
          <button type="button" className="btn btn-sm" onClick={props.onOpenAiForThread}>
            <Sparkles size={13} />
            Summarize / Tasks
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => window.print()}
            title="Print conversation"
            aria-label="Print conversation"
          >
            <Printer size={16} />
          </button>
        </div>
      </div>

      {/* Scrollable Thread Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--pane-pad)' }}>
        <div style={{ maxWidth: 880, margin: '0 auto' }}>
          {/* Subject & Labels Header */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.3 }}>
                {thread.subject}
              </h1>
              {messages.length > 1 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm no-print"
                  onClick={() => {
                    if (expandedIds.size === messages.length) {
                      setExpandedIds(new Set([latestMsg?.id].filter(Boolean) as string[]));
                    } else {
                      setExpandedIds(new Set(messages.map((m) => m.id)));
                    }
                  }}
                >
                  {expandedIds.size === messages.length ? 'Collapse all' : `Expand all (${messages.length})`}
                </button>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <span className="chip">{thread.accountEmail}</span>
              <span className="chip">
                {props.account?.accountOwnership === 'hosted' || thread.providerType === 'hosted' || thread.providerType === 'local'
                  ? 'Hosted Service'
                  : thread.providerType === 'imap_smtp'
                    ? 'IMAP/SMTP'
                    : thread.providerType}
              </span>
              {props.categories && props.categories.length > 0 ? (
                <select
                  aria-label="Thread category"
                  className="chip"
                  value={thread.categorySlug}
                  onChange={(e) => props.onBulkAction('categorize', { categorySlug: e.target.value })}
                  style={{ textTransform: 'capitalize', cursor: 'pointer' }}
                >
                  {props.categories.map((c) => (
                    <option key={c.slug} value={c.slug}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <span className="chip" style={{ textTransform: 'capitalize' }}>{thread.categorySlug}</span>
              )}
              {(thread.labels || []).map((l) => (
                <span
                  key={l.id}
                  className="chip"
                  style={{
                    background: `color-mix(in srgb, ${l.color} 15%, transparent)`,
                    color: l.color,
                  }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          </div>

          {/* Inline Task Creator */}
          {taskOpen && latestMsg && props.onCreateTask && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!taskTitle.trim()) return;
                setTaskSaving(true);
                try {
                  await props.onCreateTask!(
                    thread.id,
                    latestMsg.id,
                    taskTitle.trim(),
                    taskDue ? new Date(taskDue).toISOString() : null
                  );
                  setTaskOpen(false);
                } finally {
                  setTaskSaving(false);
                }
              }}
              style={{
                marginBottom: 14,
                padding: 14,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-elevated)',
                boxShadow: 'var(--shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <strong style={{ fontSize: 13 }}>Create Task from Thread</strong>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="field"
                  style={{ flex: 2, minWidth: 200 }}
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="Task title..."
                  required
                />
                <input
                  type="datetime-local"
                  className="field"
                  style={{ flex: 1, minWidth: 180 }}
                  value={taskDue}
                  onChange={(e) => setTaskDue(e.target.value)}
                />
                <button type="submit" className="btn btn-primary" disabled={taskSaving}>
                  {taskSaving ? 'Creating...' : 'Create Task'}
                </button>
                <button type="button" className="btn" onClick={() => setTaskOpen(false)}>Cancel</button>
              </div>
            </form>
          )}

          {/* Inline Extracted Calendar Event Preview */}
          {eventDraft && props.onSaveEvent && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setSavingEvent(true);
                try {
                  await props.onSaveEvent!({
                    accountId: thread.accountId,
                    threadId: thread.id,
                    messageId: latestMsg?.id || null,
                    title: eventDraft.title,
                    description: eventDraft.description,
                    location: eventDraft.location,
                    meetingUrl: eventDraft.meetingUrl,
                    startAt: new Date(eventDraft.startAt).toISOString(),
                    endAt: new Date(eventDraft.endAt).toISOString(),
                    attendees: eventDraft.attendees,
                    source: 'extracted',
                  });
                  setEventDraft(null);
                } finally {
                  setSavingEvent(false);
                }
              }}
              style={{
                marginBottom: 14,
                padding: 14,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--accent)',
                background: 'var(--bg-elevated)',
                boxShadow: 'var(--shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <strong style={{ fontSize: 13 }}>Confirm Extracted Calendar Event</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                <input
                  className="field"
                  value={eventDraft.title}
                  onChange={(e) => setEventDraft({ ...eventDraft, title: e.target.value })}
                  placeholder="Event title"
                  required
                />
                <input
                  type="datetime-local"
                  className="field"
                  value={eventDraft.startAt}
                  onChange={(e) => setEventDraft({ ...eventDraft, startAt: e.target.value })}
                  required
                />
                <input
                  type="datetime-local"
                  className="field"
                  value={eventDraft.endAt}
                  onChange={(e) => setEventDraft({ ...eventDraft, endAt: e.target.value })}
                  required
                />
                <input
                  className="field"
                  value={eventDraft.location}
                  onChange={(e) => setEventDraft({ ...eventDraft, location: e.target.value })}
                  placeholder="Location or meeting link"
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={savingEvent}>
                  {savingEvent ? 'Saving...' : 'Add to Calendar'}
                </button>
                <button type="button" className="btn" onClick={() => setEventDraft(null)}>Dismiss</button>
              </div>
            </form>
          )}

          {/* Messages */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.map((m) => {
              const isExpanded = expandedIds.has(m.id);
              const spfFail = m.authResults?.spf && m.authResults.spf !== 'pass';
              const dmarcFail = m.authResults?.dmarc && m.authResults.dmarc !== 'pass';

              return (
                <div
                  key={m.id}
                  ref={(el) => {
                    msgRefs.current[m.id] = el;
                  }}
                  style={{
                    border: `1px solid ${isExpanded ? 'var(--border-subtle)' : 'var(--border-hairline)'}`,
                    borderRadius: 'var(--radius-lg)',
                    background: 'var(--bg-elevated)',
                    boxShadow: isExpanded ? 'var(--shadow-sm)' : 'none',
                    overflow: 'hidden',
                  }}
                >
                  {/* Accessible Collapsible Message Header */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpand(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(m.id);
                      }
                    }}
                    style={{
                      padding: '12px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      cursor: 'pointer',
                      background: isExpanded ? 'transparent' : 'var(--bg-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <AvatarBadge name={m.fromName || m.fromAddress} color={thread.accountColor} size={32} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 13.5 }}>{m.fromName || m.fromAddress}</strong>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyAddress(m.fromAddress);
                            }}
                            title="Copy email address"
                            style={{
                              height: 20,
                              padding: '0 4px',
                              fontSize: 12,
                              color: copiedAddr === m.fromAddress ? 'var(--status-success)' : 'var(--text-muted)',
                              borderRadius: 'var(--radius-xs)',
                            }}
                          >
                            &lt;{m.fromAddress}&gt;{copiedAddr === m.fromAddress ? ' ✓' : ''}
                          </button>
                          {!spfFail && !dmarcFail ? (
                            <span title={formatAuthTooltip(m)} style={{ color: 'var(--status-success)', display: 'inline-flex' }}>
                              <ShieldCheck size={14} />
                            </span>
                          ) : (
                            <span
                              className="chip"
                              title={formatAuthTooltip(m)}
                              style={{ height: 18, fontSize: 10.5, background: 'var(--status-warning-bg)', color: 'var(--status-warning)' }}
                            >
                              Auth warning
                            </span>
                          )}
                          {m.folderRole === 'sent' && m.deliveryStatus && m.deliveryStatus !== 'synced' && (
                            <span
                              className="chip"
                              title={m.deliveryDetail || m.deliveryStatus}
                              style={{
                                height: 18,
                                fontSize: 10.5,
                                color:
                                  m.deliveryStatus === 'bounced' || m.deliveryStatus === 'failed'
                                    ? 'var(--status-danger)'
                                    : m.deliveryStatus === 'retry_pending' || m.deliveryStatus === 'queued'
                                      ? 'var(--status-warning)'
                                      : 'var(--status-success)',
                              }}
                            >
                              {m.deliveryStatus === 'accepted_local'
                                ? 'Delivered internally'
                                : m.deliveryStatus === 'accepted_by_mx'
                                  ? 'Accepted by MX'
                                  : m.deliveryStatus === 'retry_pending'
                                    ? 'Retry pending'
                                    : m.deliveryStatus === 'queued'
                                      ? 'Queued'
                                      : m.deliveryStatus}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
                          {isExpanded ? (
                            <>
                              To: {m.to.map((r) => r.name || r.address).join(', ')}
                              {m.cc.length > 0 && ` · CC: ${m.cc.map((r) => r.name || r.address).join(', ')}`}
                            </>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>{m.snippet}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {!isExpanded && m.hasAttachments && <Paperclip size={13} color="var(--text-muted)" />}
                      <span className="tabular" style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {formatFullTimestamp(m.receivedAt, props.preferences.general.timeFormat)}
                      </span>
                      {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </div>
                  </div>

                  {/* Expanded Message Body */}
                  {isExpanded && (
                    <div style={{ padding: '4px 16px 16px' }}>
                      {/* Suspicious Links Warning */}
                      {m.suspiciousLinks.length > 0 && (
                        <div
                          role="alert"
                          style={{
                            marginBottom: 12,
                            padding: '10px 12px',
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--status-danger-bg)',
                            border: '1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)',
                            color: 'var(--status-danger)',
                            fontSize: 12.5,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <ShieldAlert size={15} /> Suspicious link(s) detected
                            </strong>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => setConfirmBlockEmail(m.fromAddress)}
                            >
                              <UserX size={12} /> Block sender
                            </button>
                          </div>
                          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                            {m.suspiciousLinks.map((lnk, idx) => (
                              <li key={idx}>
                                {lnk.reason} (<code>{lnk.href}</code>)
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* External Images Privacy Control */}
                      {m.hasExternalImages &&
                        props.preferences.email.loadExternalImages === 'ask' &&
                        !revealedImagesMsgIds.has(m.id) && (
                          <div
                            className="no-print"
                            style={{
                              marginBottom: 12,
                              padding: '8px 12px',
                              borderRadius: 'var(--radius-md)',
                              background: 'var(--bg-subtle)',
                              border: '1px solid var(--border-hairline)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 10,
                              fontSize: 12.5,
                            }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                              <ImageIcon size={14} /> External images were hidden to protect your privacy.
                            </span>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setRevealedImagesMsgIds((prev) => new Set(prev).add(m.id))}
                            >
                              Load images
                            </button>
                          </div>
                        )}

                      {/* Sanitized Email HTML */}
                      <div
                        className="cadence-mail-body"
                        dangerouslySetInnerHTML={{ __html: sanitizedBodiesById[m.id] || '' }}
                      />

                      {/* Attachments */}
                      {m.attachments.length > 0 && (
                        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-hairline)' }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Paperclip size={13} /> Attachments ({m.attachments.length})
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {m.attachments.map((att) => (
                              <div
                                key={att.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '6px 10px',
                                  borderRadius: 'var(--radius-md)',
                                  border: '1px solid var(--border-hairline)',
                                  background: 'var(--bg-subtle)',
                                  fontSize: 12.5,
                                }}
                              >
                                <span style={{ fontWeight: 500 }}>{att.filename}</span>
                                <span className="tabular" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  {formatBytes(att.sizeBytes)}
                                </span>
                                {(att.mimeType.startsWith('image/') || isPreviewableTextMime(att.mimeType)) && (
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-icon"
                                    style={{ width: 24, height: 24 }}
                                    onClick={() => setPreviewAtt(att)}
                                    title="Preview attachment"
                                    aria-label={`Preview ${att.filename}`}
                                  >
                                    <Eye size={13} />
                                  </button>
                                )}
                                <a
                                  href={`/api/v1/threads/attachments/${att.id}`}
                                  download={att.filename}
                                  className="btn btn-ghost btn-icon"
                                  style={{ width: 24, height: 24 }}
                                  title="Download"
                                  aria-label={`Download ${att.filename}`}
                                >
                                  <Download size={13} />
                                </a>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Per-message Quick Actions */}
                      <div className="no-print" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-sm" onClick={() => props.onReply(m, 'reply')}>
                          <Reply size={13} /> Reply
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => props.onReply(m, 'reply_all')}>
                          <ReplyAll size={13} /> Reply All
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => props.onReply(m, 'forward')}>
                          <Forward size={13} /> Forward
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            if (reminderOpen) {
                              setReminderOpen(false);
                              return;
                            }
                            setReminderTitle(`Follow up: ${m.subject}`);
                            const tmrw = new Date(Date.now() + 86_400_000);
                            setReminderDue(toLocalDateTimeInputValue(tmrw));
                            setReminderError(null);
                            setReminderOpen(true);
                            requestAnimationFrame(() => {
                              reminderFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            });
                          }}
                        >
                          <BellPlus size={13} /> Follow-up reminder
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setConfirmBlockEmail(m.fromAddress)}
                        >
                          <UserX size={13} /> Block {m.fromAddress}
                        </button>
                        {props.onCreateRuleFromSender && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => props.onCreateRuleFromSender!(m.fromAddress, m.subject)}
                          >
                            <Filter size={13} /> Create rule
                          </button>
                        )}
                        {m.listUnsubscribe && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setConfirmUnsub({ from: m.fromAddress, ...m.listUnsubscribe })}
                          >
                            <ExternalLink size={13} /> Unsubscribe
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Jump Pills for Long Threads */}
          {messages.length > 2 && (
            <div className="no-print" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Jump to message:</span>
              {messages.map((m, idx) => (
                <button
                  key={`jump-${m.id}`}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ height: 22, padding: '0 8px', fontSize: 11, borderRadius: 'var(--radius-pill)' }}
                  onClick={() => {
                    setExpandedIds((prev) => new Set(prev).add(m.id));
                    msgRefs.current[m.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  #{idx + 1} {m.fromName || m.fromAddress.split('@')[0]}
                </button>
              ))}
            </div>
          )}

          {/* Inline Quick Reply Box */}
          {latestMsg && props.onQuickReplySend && (
            <div
              className="no-print"
              style={{
                marginTop: 14,
                borderRadius: 'var(--radius-lg)',
                border: `1px solid ${quickReplyOpen ? 'var(--accent)' : 'var(--border-subtle)'}`,
                boxShadow: 'var(--shadow-sm)',
                background: 'var(--bg-elevated)',
                padding: quickReplyOpen ? 14 : '10px 14px',
                transition: 'border-color var(--duration-fast) var(--ease-standard)',
              }}
            >
              {!quickReplyOpen ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      fontSize: 13,
                      padding: '4px 0',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setQuickReplyError(null);
                      setQuickReplyOpen(true);
                    }}
                  >
                    Write a quick reply to {latestMsg.fromName || latestMsg.fromAddress}...
                  </button>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setQuickReplyMode('reply');
                        setQuickReplyError(null);
                        setQuickReplyOpen(true);
                      }}
                    >
                      <Reply size={13} /> Quick Reply
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => props.onReply(latestMsg, 'reply_all')}
                    >
                      <ReplyAll size={13} /> Reply All
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitQuickReply();
                  }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Quick reply:</span>
                      <button
                        type="button"
                        className={`btn btn-sm ${quickReplyMode === 'reply' ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ height: 24, fontSize: 11.5 }}
                        onClick={() => setQuickReplyMode('reply')}
                      >
                        Reply ({latestMsg.fromAddress})
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${quickReplyMode === 'reply_all' ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ height: 24, fontSize: 11.5 }}
                        onClick={() => setQuickReplyMode('reply_all')}
                      >
                        Reply All
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ height: 24, fontSize: 11.5 }}
                      onClick={() => {
                        props.onReply(
                          latestMsg,
                          quickReplyMode,
                          quickReplyText.trim() ? textToParagraphHtml(quickReplyText) : undefined
                        );
                        setQuickReplyOpen(false);
                        setQuickReplyError(null);
                      }}
                    >
                      <Maximize2 size={12} /> Pop out to rich composer
                    </button>
                  </div>
                  <textarea
                    aria-label="Quick reply body"
                    autoFocus
                    className="field"
                    rows={3}
                    placeholder={`Reply to ${latestMsg.fromName || latestMsg.fromAddress}... (Ctrl+Enter to send)`}
                    value={quickReplyText}
                    onChange={(e) => setQuickReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void submitQuickReply();
                      }
                    }}
                    required
                  />
                  {quickReplyError && (
                    <div style={{ fontSize: 12, color: 'var(--status-danger)' }}>{quickReplyError}</div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      <span className="kbd">Ctrl+Enter</span> to send
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setQuickReplyOpen(false);
                          setQuickReplyError(null);
                        }}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={quickReplySending || !quickReplyText.trim()}>
                        <Send size={12} /> {quickReplySending ? 'Sending...' : 'Send Reply'}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Inline Follow-up Reminder Creator */}
          {reminderOpen && latestMsg && (
            <form
              ref={reminderFormRef}
              onSubmit={async (e) => {
                e.preventDefault();
                setReminderSaving(true);
                setReminderError(null);
                try {
                  await props.onCreateReminder(thread.id, latestMsg.id, reminderTitle, new Date(reminderDue).toISOString());
                  setReminderOpen(false);
                } catch (err) {
                  setReminderError(err instanceof Error ? err.message : 'Could not schedule reminder.');
                } finally {
                  setReminderSaving(false);
                }
              }}
              style={{
                marginTop: 14,
                padding: 14,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-elevated)',
                boxShadow: 'var(--shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <strong style={{ fontSize: 13 }}>Schedule Follow-up Reminder</strong>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="field"
                  style={{ flex: 2, minWidth: 200 }}
                  value={reminderTitle}
                  onChange={(e) => setReminderTitle(e.target.value)}
                  required
                />
                <input
                  type="datetime-local"
                  className="field"
                  style={{ flex: 1, minWidth: 180 }}
                  value={reminderDue}
                  onChange={(e) => setReminderDue(e.target.value)}
                  required
                />
                <button type="submit" className="btn btn-primary" disabled={reminderSaving}>
                  {reminderSaving ? 'Saving...' : 'Save'}
                </button>
                <button type="button" className="btn" onClick={() => setReminderOpen(false)}>Cancel</button>
              </div>
              {reminderError && <div style={{ fontSize: 12, color: 'var(--status-danger)' }}>{reminderError}</div>}
            </form>
          )}
        </div>
      </div>

      {/* Block Sender Confirmation Modal */}
      {confirmBlockEmail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm block sender"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 95,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
          onClick={() => setConfirmBlockEmail(null)}
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
            <strong style={{ fontSize: 15 }}>Block {confirmBlockEmail}?</strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Messages from <code>{confirmBlockEmail}</code> will automatically be moved to Spam. You can unblock senders anytime in Settings.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setConfirmBlockEmail(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const target = confirmBlockEmail;
                  setConfirmBlockEmail(null);
                  props.onBlockSender(target);
                }}
              >
                Block Sender
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List-Unsubscribe Confirmation Modal */}
      {confirmUnsub && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm unsubscribe"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 95,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
          onClick={() => setConfirmUnsub(null)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 420,
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
            <strong style={{ fontSize: 15 }}>Unsubscribe from {confirmUnsub.from}?</strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Cadence extracted a verified <code>List-Unsubscribe</code> header for this mailing list. Choose how to proceed:
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={() => setConfirmUnsub(null)}>Cancel</button>
              {confirmUnsub.mailto && props.onUnsubscribeMailto && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const addr = confirmUnsub.mailto!;
                    setConfirmUnsub(null);
                    props.onUnsubscribeMailto!(addr, thread.subject);
                  }}
                >
                  Compose Unsubscribe Email
                </button>
              )}
              {confirmUnsub.httpUrl && (
                <a
                  href={confirmUnsub.httpUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="btn btn-primary"
                  onClick={() => setConfirmUnsub(null)}
                >
                  Open Unsubscribe Link
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Attachment Preview Modal */}
      {previewAtt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewAtt.filename}`}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 90,
            display: 'grid',
            placeItems: 'center',
            padding: 24,
          }}
          onClick={() => setPreviewAtt(null)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 740,
              maxHeight: '85vh',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-xl)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: 'var(--shadow-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{previewAtt.filename}</strong>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <a
                  href={`/api/v1/threads/attachments/${previewAtt.id}`}
                  download={previewAtt.filename}
                  className="btn btn-sm"
                >
                  <ExternalLink size={13} /> Download
                </a>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ width: 28, height: 28 }}
                  aria-label="Close attachment preview"
                  onClick={() => setPreviewAtt(null)}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div style={{ padding: 20, overflow: 'auto', textAlign: 'center' }}>
              {previewAtt.mimeType.startsWith('image/') ? (
                <img
                  src={`/api/v1/threads/attachments/${previewAtt.id}?inline=1`}
                  alt={previewAtt.filename}
                  style={{ maxWidth: '100%', maxHeight: '65vh', borderRadius: 'var(--radius-md)' }}
                />
              ) : previewText.loading ? (
                <div className="skeleton" style={{ height: 220, width: '100%', borderRadius: 'var(--radius-md)' }} />
              ) : previewText.error ? (
                <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>{previewText.error}</div>
              ) : (
                <div style={{ textAlign: 'left' }}>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 16,
                      maxHeight: '58vh',
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      background: 'var(--bg-subtle)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-hairline)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    {previewText.content ?? ''}
                  </pre>
                  {previewText.truncated && (
                    <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
                      Preview truncated at 256 KB. Download the file to view all contents.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
