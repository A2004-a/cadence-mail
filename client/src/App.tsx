import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { OfflineError, apiRequest, setCsrfToken } from './api/client';
import { AuthScreen } from './components/AuthScreen';
import { ACCENT_PRESETS } from './components/CadenceMark';
import type { ComposerWindowState } from './components/ComposerDock';
import { EmailList } from './components/EmailList';
import { ReadingPane } from './components/ReadingPane';
import { Sidebar } from './components/Sidebar';
import { TopToolbar } from './components/TopToolbar';

const AiAssistantPanel = lazy(() =>
  import('./components/AiAssistantPanel').then((m) => ({ default: m.AiAssistantPanel }))
);
const ComposerDock = lazy(() =>
  import('./components/ComposerDock').then((m) => ({ default: m.ComposerDock }))
);
const ContactsView = lazy(() =>
  import('./components/ContactsView').then((m) => ({ default: m.ContactsView }))
);
const RulesView = lazy(() =>
  import('./components/RulesView').then((m) => ({ default: m.RulesView }))
);
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((m) => ({ default: m.SettingsView }))
);
const TemplatesView = lazy(() =>
  import('./components/TemplatesAndRemindersView').then((m) => ({ default: m.TemplatesView }))
);
const RemindersView = lazy(() =>
  import('./components/TemplatesAndRemindersView').then((m) => ({ default: m.RemindersView }))
);
const ConnectRealMailPanel = lazy(() =>
  import('./components/ConnectRealMailPanel').then((m) => ({ default: m.ConnectRealMailPanel }))
);
const AdminConsoleView = lazy(() =>
  import('./components/AdminConsoleView').then((m) => ({ default: m.AdminConsoleView }))
);
const TasksView = lazy(() =>
  import('./components/TasksView').then((m) => ({ default: m.TasksView }))
);
const CalendarView = lazy(() =>
  import('./components/CalendarView').then((m) => ({ default: m.CalendarView }))
);
const AttachmentsView = lazy(() =>
  import('./components/AttachmentsView').then((m) => ({ default: m.AttachmentsView }))
);
const CollaborationView = lazy(() =>
  import('./components/CollaborationView').then((m) => ({ default: m.CollaborationView }))
);

function isClientQuietHours(prefs: UserPreferences): boolean {
  if (!prefs.notifications.quietHoursEnabled) return false;
  const toMin = (hhmm: string) => {
    const [h, m] = (hhmm || '').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const start = toMin(prefs.notifications.quietHoursStart);
  const end = toMin(prefs.notifications.quietHoursEnd);
  if (start === end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
import {
  cacheThreadDetail,
  cacheThreadList,
  enqueuePendingAction,
  getCachedThreadDetail,
  getCachedThreadList,
  listPendingActions,
  removePendingAction,
} from './offline/offlineStore';
import type {
  Account,
  ActiveWorkspaceSection,
  Category,
  Draft,
  EmailMessage,
  Folder,
  Label,
  MailView,
  NotificationItem,
  SearchMeta,
  Template,
  ThreadSummary,
  SavedSearch,
  UserPreferences,
  ViewCounts,
} from './types';

const EMPTY_COUNTS: ViewCounts = {
  inboxUnread: 0,
  inboxTotal: 0,
  priorityUnread: 0,
  starred: 0,
  important: 0,
  snoozed: 0,
  spam: 0,
  trash: 0,
  drafts: 0,
  categories: {},
};

const DEFAULT_PREFS: UserPreferences = {
  general: { language: 'en', timezone: 'UTC', defaultFont: 'Onest', defaultFontSize: '14px', dateFormat: 'relative', timeFormat: '12h' },
  appearance: { theme: 'system', accentColor: '#1D4ED8', sidebarCollapsed: false, layoutMode: 'split-right', density: 'comfortable', animationsEnabled: true },
  inbox: { categoriesEnabled: true, conversationView: true, sortBy: 'date_desc', readingPaneAutoAdvance: 'next', priorityInboxEnabled: true },
  email: { defaultReplyBehavior: 'reply', undoSendDelaySeconds: 8, autoMarkReadDelayMs: 600, loadExternalImages: 'ask', plainTextDefault: false },
  notifications: { enabled: true, importantOnly: false, soundEnabled: false, desktopNotifications: true, showPreview: true, quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', categories: ['primary', 'work'] },
  ai: { enabled: false, privacyDisclosureAccepted: false, redactSensitiveContent: true, defaultTone: 'professional', defaultTargetLanguage: 'Spanish', smartRepliesEnabled: true },
};

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [user, setUser] = useState<{ id: string; email: string; name: string; role?: 'admin' | 'member' } | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFS);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | 'all'>('all');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [pendingReminderCount, setPendingReminderCount] = useState(0);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [openTaskCount, setOpenTaskCount] = useState(0);
  const [rulePrefill, setRulePrefill] = useState<{ fromAddress: string; subject: string } | null>(null);

  const [activeSection, setActiveSection] = useState<ActiveWorkspaceSection>('mail');
  const [activeView, setActiveView] = useState<MailView>('inbox');
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [hasAttachmentOnly, setHasAttachmentOnly] = useState(false);

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [totalThreads, setTotalThreads] = useState(0);
  const [counts, setCounts] = useState<ViewCounts>(EMPTY_COUNTS);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [activeMessages, setActiveMessages] = useState<EmailMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIdxRef = useRef<number | null>(null);
  const openThreadSeqRef = useRef(0);
  const markReadTimerRef = useRef<number | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [highlightTerms, setHighlightTerms] = useState<string[]>([]);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [includeRemoteSearch, setIncludeRemoteSearch] = useState(false);
  const [searchHistory, setSearchHistory] = useState<Array<{ id: string; query: string }>>([]);

  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [pendingOfflineCount, setPendingOfflineCount] = useState(0);

  const [composerWindows, setComposerWindows] = useState<ComposerWindowState[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    undoDraftId?: string;
    undoThreadAction?: { threadIds: string[]; label: string };
    expiresAt?: number;
  } | null>(null);
  const [toastSecondsLeft, setToastSecondsLeft] = useState<number>(0);

  useEffect(() => {
    if (!toast) {
      setToastSecondsLeft(0);
      return;
    }
    const delayMs = toast.expiresAt ? Math.max(2000, toast.expiresAt - Date.now() + 1500) : 5000;
    const t = window.setTimeout(() => setToast(null), delayMs);
    let intervalId: number | null = null;
    if (toast.expiresAt && toast.undoDraftId) {
      const updateTick = () => {
        setToastSecondsLeft(Math.max(0, Math.ceil((toast.expiresAt! - Date.now()) / 1000)));
      };
      updateTick();
      intervalId = window.setInterval(updateTick, 500);
    }
    return () => {
      window.clearTimeout(t);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [toast]);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 960px)').matches : false
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 960px)');
    const onChange = () => setIsMobileViewport(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Apply theme, accent, density, animations
  useEffect(() => {
    const root = document.documentElement;
    const sysDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const effectiveTheme =
      preferences.appearance.theme === 'system' ? (sysDark ? 'dark' : 'light') : preferences.appearance.theme;

    root.setAttribute('data-theme', effectiveTheme);
    root.setAttribute('data-density', preferences.appearance.density);
    root.setAttribute('data-animations', preferences.appearance.animationsEnabled ? 'on' : 'off');

    const preset = ACCENT_PRESETS.find((p) => p.light === preferences.appearance.accentColor);
    const accentHex = effectiveTheme === 'dark' && preset ? preset.dark : preferences.appearance.accentColor;
    const solidHex = effectiveTheme === 'dark' ? '#2563EB' : preferences.appearance.accentColor;
    const solidChosen = preset && effectiveTheme === 'dark'
      ? (preset.light === '#1D4ED8' ? '#2563EB' : preset.light)
      : solidHex;
    root.style.setProperty('--accent', accentHex);
    root.style.setProperty('--accent-solid', solidChosen);
    root.style.setProperty('--accent-hover', solidChosen);
  }, [preferences.appearance]);

  const refreshMetadata = useCallback(async () => {
    const [acctRes, fldRes, lblRes, catRes, tplRes, notifRes, histRes, remRes, savedRes, taskRes] = await Promise.all([
      apiRequest<{ accounts: Account[] }>('/accounts'),
      apiRequest<{ folders: Folder[] }>('/org/folders'),
      apiRequest<{ labels: Label[] }>('/org/labels'),
      apiRequest<{ categories: Category[] }>('/org/categories'),
      apiRequest<{ templates: Template[] }>('/productivity/templates'),
      apiRequest<{ notifications: NotificationItem[]; unreadCount: number }>('/productivity/notifications'),
      apiRequest<{ history: Array<{ id: string; query: string }> }>('/org/search/history'),
      apiRequest<{ reminders: Array<{ status: string }> }>('/productivity/reminders'),
      apiRequest<{ savedSearches: SavedSearch[] }>('/org/saved-searches'),
      apiRequest<{ tasks: Array<{ status: string }> }>('/workspace/tasks?view=all'),
    ]);
    setAccounts(acctRes.accounts);
    setFolders(fldRes.folders);
    setLabels(lblRes.labels);
    setCategories(catRes.categories);
    setTemplates(tplRes.templates);
    setNotifications(notifRes.notifications);
    setUnreadNotifCount(notifRes.unreadCount);
    setSearchHistory(histRes.history);
    setPendingReminderCount(remRes.reminders.filter((r) => r.status === 'pending' || r.status === 'triggered').length);
    setSavedSearches(savedRes.savedSearches);
    setOpenTaskCount(taskRes.tasks.filter((t) => t.status !== 'completed').length);
  }, []);

  const loadThreads = useCallback(async () => {
    if (authState !== 'authenticated') return;
    setListLoading(true);
    setListError(null);
    const cacheKey = `${selectedAccountId}:${activeView}:${activeFolderId || ''}:${activeLabelId || ''}:${activeCategory || ''}:${unreadOnly}:${hasAttachmentOnly}`;

    try {
      if (activeView === 'drafts') {
        const dRes = await apiRequest<{ drafts: Draft[] }>('/drafts');
        setDrafts(dRes.drafts);
        setListLoading(false);
        return;
      }

      if (activeView === 'search') {
        const sRes = await apiRequest<{ threads: ThreadSummary[]; highlightTerms: string[]; searchMeta?: SearchMeta }>(
          `/org/search?q=${encodeURIComponent(searchQuery)}${selectedAccountId !== 'all' ? `&accountId=${selectedAccountId}` : ''}${includeRemoteSearch ? '&remote=true' : ''}`
        );
        setThreads(sRes.threads);
        setHighlightTerms(sRes.highlightTerms || []);
        setSearchMeta(sRes.searchMeta || null);
        setListLoading(false);
        return;
      }

      const params = new URLSearchParams({
        view: activeView,
        sortBy: preferences.inbox.sortBy,
        unreadOnly: String(unreadOnly),
        hasAttachment: String(hasAttachmentOnly),
      });
      if (selectedAccountId !== 'all') params.set('accountId', selectedAccountId);
      if (activeCategory) params.set('category', activeCategory);
      if (activeFolderId && activeView === 'folder') params.set('folderId', activeFolderId);
      if (activeLabelId && activeView === 'label') params.set('labelId', activeLabelId);

      const res = await apiRequest<{ threads: ThreadSummary[]; total: number; counts: ViewCounts }>(`/threads?${params.toString()}`);
      setThreads(res.threads);
      setTotalThreads(res.total);
      setCounts(res.counts);
      setHighlightTerms([]);
      void cacheThreadList(cacheKey, res.threads);
    } catch (err) {
      if (err instanceof OfflineError) {
        const cached = await getCachedThreadList(cacheKey);
        if (cached) {
          setThreads(cached);
          setTotalThreads(cached.length);
        } else {
          setListError('Offline and no cached messages for this view.');
        }
      } else {
        setListError(err instanceof Error ? err.message : 'Unable to fetch messages');
      }
    } finally {
      setListLoading(false);
    }
  }, [
    authState,
    selectedAccountId,
    activeView,
    activeFolderId,
    activeLabelId,
    activeCategory,
    unreadOnly,
    hasAttachmentOnly,
    preferences.inbox.sortBy,
    searchQuery,
    includeRemoteSearch,
  ]);

  const loadMoreThreads = useCallback(async () => {
    if (authState !== 'authenticated' || loadingMore || threads.length >= totalThreads) return;
    if (activeView === 'drafts' || activeView === 'search') return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        view: activeView,
        sortBy: preferences.inbox.sortBy,
        unreadOnly: String(unreadOnly),
        hasAttachment: String(hasAttachmentOnly),
        limit: '60',
        offset: String(threads.length),
      });
      if (selectedAccountId !== 'all') params.set('accountId', selectedAccountId);
      if (activeCategory) params.set('category', activeCategory);
      if (activeFolderId && activeView === 'folder') params.set('folderId', activeFolderId);
      if (activeLabelId && activeView === 'label') params.set('labelId', activeLabelId);

      const res = await apiRequest<{ threads: ThreadSummary[]; total: number; counts: ViewCounts }>(`/threads?${params.toString()}`);
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        const extra = res.threads.filter((t) => !seen.has(t.id));
        return [...prev, ...extra];
      });
      setTotalThreads(res.total);
      setCounts(res.counts);
    } finally {
      setLoadingMore(false);
    }
  }, [
    authState,
    loadingMore,
    threads.length,
    totalThreads,
    activeView,
    preferences.inbox.sortBy,
    unreadOnly,
    hasAttachmentOnly,
    selectedAccountId,
    activeCategory,
    activeFolderId,
    activeLabelId,
  ]);

  const loadBootstrap = useCallback(async () => {
    try {
      const sess = await apiRequest<{
        authenticated: boolean;
        user: { id: string; email: string; name: string; role?: 'admin' | 'member' } | null;
        csrfToken?: string;
        preferences?: UserPreferences | null;
      }>('/auth/session');
      if (!sess.authenticated || !sess.user || !sess.csrfToken) {
        setAuthState('unauthenticated');
        return;
      }
      setUser(sess.user);
      setCsrfToken(sess.csrfToken);
      if (sess.preferences) setPreferences(sess.preferences);
      setAuthState('authenticated');
      await refreshMetadata();
    } catch {
      setAuthState('unauthenticated');
    }
  }, [refreshMetadata]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (authState === 'authenticated') {
      void loadThreads();
      if (typeof window !== 'undefined' && window.location.search) {
        const sp = new URLSearchParams(window.location.search);
        const oauthConnected = sp.get('oauth_connected');
        const oauthError = sp.get('oauth_error');
        if (oauthConnected || oauthError) {
          sp.delete('oauth_connected');
          sp.delete('oauth_error');
          const cleanQs = sp.toString();
          const nextUrl = `${window.location.pathname}${cleanQs ? `?${cleanQs}` : ''}${window.location.hash}`;
          window.history.replaceState({}, document.title, nextUrl);
          if (oauthConnected) {
            setToast({ message: `Connected OAuth2 mailbox ${oauthConnected} and synced recent messages.` });
            void refreshMetadata().then(() => loadThreads());
          } else if (oauthError) {
            setToast({ message: `OAuth2 connection failed: ${oauthError}` });
          }
        }
      }
    }
  }, [authState, loadThreads, refreshMetadata]);

  // Flush offline pending actions
  const flushOfflineQueue = useCallback(async () => {
    const queue = await listPendingActions();
    setPendingOfflineCount(queue.length);
    if (!navigator.onLine || queue.length === 0) return;

    for (const item of queue) {
      try {
        await apiRequest(item.endpoint, { method: item.method, body: item.body });
        await removePendingAction(item.id);
      } catch (err) {
        if (err instanceof OfflineError) break;
      }
    }
    const remaining = await listPendingActions();
    setPendingOfflineCount(remaining.length);
    if (remaining.length < queue.length) {
      await loadThreads();
      await refreshMetadata();
    }
  }, [loadThreads, refreshMetadata]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void flushOfflineQueue();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    void listPendingActions().then((q) => setPendingOfflineCount(q.length));
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flushOfflineQueue]);

  // Real-time SSE events
  useEffect(() => {
    if (authState !== 'authenticated') return;
    const es = new EventSource('/api/v1/events', { withCredentials: true });
    const refreshHandler = () => {
      void loadThreads();
      void refreshMetadata();
    };
    es.addEventListener('new_message', (ev) => {
      refreshHandler();
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        if (
          preferences.notifications.enabled &&
          preferences.notifications.desktopNotifications &&
          !isClientQuietHours(preferences) &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          new Notification(data.payload?.from || 'New Email', {
            body: preferences.notifications.showPreview ? data.payload?.subject : 'New message arrived',
          });
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener('message_sent', refreshHandler);
    es.addEventListener('thread_updated', refreshHandler);
    es.addEventListener('sync_completed', refreshHandler);
    es.addEventListener('automation_executed', refreshHandler);
    es.addEventListener('task_updated', () => {
      void refreshMetadata();
    });
    es.addEventListener('calendar_updated', () => {
      void refreshMetadata();
    });
    es.addEventListener('reminder_due', (ev) => {
      refreshHandler();
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        setToast({ message: `Reminder: ${data.payload?.title || 'Follow up'}` });
      } catch {
        // ignore
      }
    });
    return () => es.close();
  }, [authState, loadThreads, refreshMetadata, preferences.notifications]);

  // Load selected thread (race-safe & honors autoMarkReadDelayMs)
  const openThread = useCallback(
    async (threadId: string) => {
      const seq = ++openThreadSeqRef.current;
      if (markReadTimerRef.current) {
        window.clearTimeout(markReadTimerRef.current);
        markReadTimerRef.current = null;
      }
      setSelectedThreadId(threadId);
      setThreadLoading(true);
      try {
        const detail = await apiRequest<{ thread: ThreadSummary; messages: EmailMessage[] }>(`/threads/${threadId}`);
        if (seq !== openThreadSeqRef.current) return;
        setActiveThread(detail.thread);
        setActiveMessages(detail.messages);
        void cacheThreadDetail(threadId, detail);

        if (detail.thread.unreadCount > 0) {
          const delayMs = Math.max(0, preferences.email.autoMarkReadDelayMs ?? 600);
          const markAsReadNow = async () => {
            if (seq !== openThreadSeqRef.current) return;
            await apiRequest('/threads/bulk', {
              method: 'POST',
              body: { threadIds: [threadId], action: 'mark_read' },
            });
            if (seq !== openThreadSeqRef.current) return;
            setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t)));
            setActiveThread((prev) => (prev && prev.id === threadId ? { ...prev, unreadCount: 0 } : prev));
            void refreshMetadata();
          };
          if (delayMs === 0) {
            await markAsReadNow();
          } else {
            markReadTimerRef.current = window.setTimeout(() => {
              void markAsReadNow();
            }, delayMs);
          }
        }
      } catch (err) {
        if (seq !== openThreadSeqRef.current) return;
        if (err instanceof OfflineError) {
          const cached = await getCachedThreadDetail(threadId);
          if (cached) {
            setActiveThread(cached.thread);
            setActiveMessages(cached.messages);
          }
        } else {
          setToast({ message: 'Unable to load conversation details.' });
        }
      } finally {
        if (seq === openThreadSeqRef.current) {
          setThreadLoading(false);
        }
      }
    },
    [preferences.email.autoMarkReadDelayMs, refreshMetadata]
  );

  // Bulk Action with offline queue fallback, auto-advance, and reversible undo toast
  const handleBulkAction = useCallback(
    async (
      threadIds: string[],
      action: any,
      extra?: { snoozedUntil?: string; folderId?: string; labelId?: string; categorySlug?: string }
    ) => {
      if (threadIds.length === 0) return;
      const body = { threadIds, action, ...extra };
      const removingActions = ['archive', 'delete', 'spam', 'snooze', 'permanent_delete'];
      const isRemoving = removingActions.includes(action);

      let autoAdvanceTargetId: string | null = null;
      if (isRemoving && selectedThreadId && threadIds.includes(selectedThreadId)) {
        const mode = preferences.inbox.readingPaneAutoAdvance;
        const remaining = threads.filter((t) => !threadIds.includes(t.id));
        if (mode !== 'list' && remaining.length > 0 && !isMobileViewport) {
          const curIdx = threads.findIndex((t) => t.id === selectedThreadId);
          if (mode === 'prev') {
            const pick = threads.slice(0, curIdx).reverse().find((t) => !threadIds.includes(t.id)) || remaining[0];
            autoAdvanceTargetId = pick?.id || null;
          } else {
            const pick = threads.slice(curIdx + 1).find((t) => !threadIds.includes(t.id)) || remaining[remaining.length - 1];
            autoAdvanceTargetId = pick?.id || null;
          }
        }
        setSelectedThreadId(autoAdvanceTargetId);
        if (!autoAdvanceTargetId) {
          setActiveThread(null);
          setActiveMessages([]);
        }
      }

      if (isRemoving) {
        setThreads((prev) => prev.filter((t) => !threadIds.includes(t.id)));
        setSelectedIds(new Set());
      }

      try {
        await apiRequest('/threads/bulk', { method: 'POST', body });
        await loadThreads();
        await refreshMetadata();

        if (autoAdvanceTargetId) {
          await openThread(autoAdvanceTargetId);
        } else if (selectedThreadId && threadIds.includes(selectedThreadId) && !isRemoving) {
          await openThread(selectedThreadId);
        }

        if (['archive', 'delete', 'spam'].includes(action)) {
          const verb = action === 'archive' ? 'Archived' : action === 'delete' ? 'Moved to Trash' : 'Marked as Spam';
          setToast({
            message: `${verb} (${threadIds.length})`,
            undoThreadAction: { threadIds, label: verb },
          });
        }
      } catch (err) {
        if (err instanceof OfflineError) {
          await enqueuePendingAction({
            endpoint: '/threads/bulk',
            method: 'POST',
            body,
            description: `${action} (${threadIds.length})`,
          });
          setThreads((prev) => prev.map((t) => (threadIds.includes(t.id) ? { ...t, syncPending: true } : t)));
          const q = await listPendingActions();
          setPendingOfflineCount(q.length);
          setToast({ message: `Saved offline: ${action} will sync when reconnected.` });
        } else {
          setToast({ message: err instanceof Error ? err.message : 'Action failed' });
        }
      }
    },
    [
      isMobileViewport,
      loadThreads,
      openThread,
      preferences.inbox.readingPaneAutoAdvance,
      refreshMetadata,
      selectedThreadId,
      threads,
    ]
  );

  // Open Composer
  const openComposer = useCallback(
    async (opts?: {
      mode?: 'new' | 'reply' | 'reply_all' | 'forward';
      replyToMessage?: EmailMessage;
      prefillTo?: Array<{ name: string; address: string }>;
      prefillSubject?: string;
      prefillBodyHtml?: string;
    }) => {
      const acct =
        (opts?.replyToMessage && accounts.find((a) => a.id === opts.replyToMessage!.accountId)) ||
        (selectedAccountId !== 'all' ? accounts.find((a) => a.id === selectedAccountId) : accounts[0]) ||
        accounts[0];
      if (!acct) {
        setConnectModalOpen(true);
        setToast({ message: 'Connect a real email account (or add a local test mailbox) first to compose.' });
        return;
      }

      const mode = opts?.mode || 'new';
      const orig = opts?.replyToMessage;
      let to = opts?.prefillTo || [];
      let cc: Array<{ name: string; address: string }> = [];
      let subject = opts?.prefillSubject || '';
      let bodyHtml = opts?.prefillBodyHtml || '';

      if (orig) {
        if (mode === 'reply') {
          to = [{ name: orig.fromName, address: orig.fromAddress }];
          subject = orig.subject.toLowerCase().startsWith('re:') ? orig.subject : `Re: ${orig.subject}`;
        } else if (mode === 'reply_all') {
          to = [{ name: orig.fromName, address: orig.fromAddress }];
          cc = [...orig.to, ...orig.cc].filter((p) => p.address.toLowerCase() !== acct.emailAddress.toLowerCase());
          subject = orig.subject.toLowerCase().startsWith('re:') ? orig.subject : `Re: ${orig.subject}`;
        } else if (mode === 'forward') {
          subject = orig.subject.toLowerCase().startsWith('fwd:') ? orig.subject : `Fwd: ${orig.subject}`;
        }
        const quote = `<br><br><blockquote><p>On ${new Date(orig.receivedAt).toLocaleString()}, ${orig.fromName || orig.fromAddress} wrote:</p>${orig.bodyHtmlSanitized}</blockquote>`;
        bodyHtml = `${bodyHtml}${acct.signatureEnabled && acct.signatureHtml ? `<br>${acct.signatureHtml}` : ''}${quote}`;
      } else if (acct.signatureEnabled && acct.signatureHtml) {
        bodyHtml = `${bodyHtml}<br><br>${acct.signatureHtml}`;
      }

      const res = await apiRequest<{ draft: Draft }>('/drafts', {
        method: 'POST',
        body: {
          accountId: acct.id,
          threadId: orig?.threadId || null,
          replyToMessageId: orig?.id || null,
          mode,
          to,
          cc,
          subject,
          bodyHtml,
          isPlainText: preferences.email.plainTextDefault,
        },
      });
      setComposerWindows((prev) => [
        ...prev.slice(-2),
        { localKey: res.draft.id, draft: res.draft, minimized: false, maximized: false },
      ]);
    },
    [accounts, preferences.email.plainTextDefault, selectedAccountId]
  );

  // Global Keyboard Shortcuts
  useEffect(() => {
    if (authState !== 'authenticated') return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (inInput) {
        if (e.key === 'Escape') target.blur();
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (e.key === '/') {
        e.preventDefault();
        document.getElementById('cadence-global-search')?.focus();
      } else if (e.key === 'c') {
        e.preventDefault();
        void openComposer();
      } else if ((e.key === 'j' || e.key === 'ArrowDown') && threads.length > 0 && activeSection === 'mail') {
        if (e.key === 'ArrowDown') e.preventDefault();
        const idx = threads.findIndex((t) => t.id === selectedThreadId);
        const next = threads[Math.min(threads.length - 1, idx + 1)];
        if (next) void openThread(next.id);
      } else if ((e.key === 'k' || e.key === 'ArrowUp') && threads.length > 0 && activeSection === 'mail') {
        if (e.key === 'ArrowUp') e.preventDefault();
        const idx = threads.findIndex((t) => t.id === selectedThreadId);
        const prev = threads[Math.max(0, idx <= 0 ? 0 : idx - 1)];
        if (prev) void openThread(prev.id);
      } else if (e.key === 'e' && selectedThreadId) {
        void handleBulkAction([selectedThreadId], 'archive');
      } else if (e.key === 's' && selectedThreadId && activeThread) {
        void handleBulkAction([selectedThreadId], activeThread.isStarred ? 'unstar' : 'star');
      } else if (e.key === '#' && selectedThreadId) {
        void handleBulkAction([selectedThreadId], 'delete');
      } else if (e.key === 'r' && activeMessages.length > 0) {
        e.preventDefault();
        void openComposer({ mode: 'reply', replyToMessage: activeMessages[activeMessages.length - 1] });
      } else if (e.key === 'a' && activeMessages.length > 0) {
        e.preventDefault();
        void openComposer({ mode: 'reply_all', replyToMessage: activeMessages[activeMessages.length - 1] });
      } else if (e.key === 'f' && activeMessages.length > 0) {
        e.preventDefault();
        void openComposer({ mode: 'forward', replyToMessage: activeMessages[activeMessages.length - 1] });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [authState, threads, selectedThreadId, activeThread, activeMessages, openComposer, openThread, handleBulkAction]);

  const updatePreferences = useCallback(async (patch: Record<string, any>) => {
    const res = await apiRequest<{ preferences: UserPreferences }>('/productivity/preferences', {
      method: 'PATCH',
      body: patch,
    });
    setPreferences(res.preferences);
  }, []);

  const effectiveLayoutMode = isMobileViewport ? 'list' : preferences.appearance.layoutMode;

  const layoutGridStyle = useMemo<React.CSSProperties>(() => {
    if (effectiveLayoutMode === 'split-bottom') {
      return { display: 'grid', gridTemplateRows: '1fr 1fr', flex: 1, overflow: 'hidden' };
    }
    if (effectiveLayoutMode === 'split-right') {
      return { display: 'grid', gridTemplateColumns: 'minmax(330px, 42%) 1fr', flex: 1, overflow: 'hidden' };
    }
    return { display: 'grid', gridTemplateColumns: '1fr', flex: 1, overflow: 'hidden' };
  }, [effectiveLayoutMode]);

  if (authState === 'loading') {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
        Loading Cadence workspace...
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <AuthScreen onAuthenticated={() => void loadBootstrap()} />;
  }

  const showListPane =
    activeSection === 'mail' &&
    (effectiveLayoutMode !== 'full-reading' || !selectedThreadId) &&
    !(effectiveLayoutMode === 'list' && selectedThreadId);

  const showReadingPane =
    activeSection === 'mail' &&
    activeView !== 'drafts' &&
    (effectiveLayoutMode === 'split-right' ||
      effectiveLayoutMode === 'split-bottom' ||
      Boolean(selectedThreadId));

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden', background: 'var(--bg-chrome)' }}>
      <Sidebar
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onSelectAccount={(id) => {
          setSelectedAccountId(id);
          setSelectedThreadId(null);
        }}
        activeSection={activeSection}
        onSelectSection={(s) => setActiveSection(s)}
        activeView={activeView}
        activeFolderId={activeFolderId}
        activeLabelId={activeLabelId}
        activeCategory={activeCategory}
        onSelectMailView={(view, opts) => {
          setActiveView(view);
          setActiveFolderId(opts?.folderId || null);
          setActiveLabelId(opts?.labelId || null);
          setActiveCategory(opts?.category || null);
          setSelectedThreadId(null);
          setActiveThread(null);
          setSelectedIds(new Set());
        }}
        counts={counts}
        folders={folders}
        labels={labels}
        categories={categories}
        collapsed={preferences.appearance.sidebarCollapsed}
        mobileOpen={mobileDrawerOpen}
        onCloseMobile={() => setMobileDrawerOpen(false)}
        onCompose={() => void openComposer()}
        onCreateFolder={async (name, accountId, color) => {
          await apiRequest('/org/folders', { method: 'POST', body: { name, accountId, color } });
          await refreshMetadata();
        }}
        onRenameFolder={async (id, name) => {
          await apiRequest(`/org/folders/${id}`, { method: 'PATCH', body: { name } });
          await refreshMetadata();
        }}
        onDeleteFolder={async (id) => {
          await apiRequest(`/org/folders/${id}`, { method: 'DELETE' });
          if (activeFolderId === id) setActiveView('inbox');
          await refreshMetadata();
          await loadThreads();
        }}
        onCreateLabel={async (name, color) => {
          await apiRequest('/org/labels', { method: 'POST', body: { name, color } });
          await refreshMetadata();
        }}
        onDeleteLabel={async (id) => {
          await apiRequest(`/org/labels/${id}`, { method: 'DELETE' });
          if (activeLabelId === id) setActiveView('inbox');
          await refreshMetadata();
          await loadThreads();
        }}
        onDropThreadToFolder={(ids, folderId) => void handleBulkAction(ids, 'move_folder', { folderId })}
        onDropThreadToLabel={(ids, labelId) => void handleBulkAction(ids, 'add_label', { labelId })}
        onConnectRealEmail={() => setConnectModalOpen(true)}
        pendingReminderCount={pendingReminderCount}
        openTaskCount={openTaskCount}
        isAdmin={user?.role === 'admin'}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <TopToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchSubmit={(q) => {
            setActiveSection('mail');
            if (!q.trim()) {
              setActiveView('inbox');
            } else {
              setActiveView('search');
            }
          }}
          onAdvancedSearch={async (f) => {
            const parts: string[] = [];
            if (f.from) parts.push(`from:${f.from}`);
            if (f.to) parts.push(`to:${f.to}`);
            if (f.subject) parts.push(`subject:"${f.subject}"`);
            if (f.hasAttachment) parts.push('has:attachment');
            if (f.after) parts.push(`after:${f.after}`);
            if (f.before) parts.push(`before:${f.before}`);
            if (f.isUnread) parts.push('is:unread');
            const q = parts.join(' ');
            setSearchQuery(q);
            setActiveSection('mail');
            setActiveView(q ? 'search' : 'inbox');
          }}
          searchHistory={searchHistory}
          savedSearches={savedSearches}
          onSaveSearch={async (name, query) => {
            await apiRequest('/org/saved-searches', { method: 'POST', body: { name, query } });
            setToast({ message: `Saved search "${name}".` });
            await refreshMetadata();
          }}
          onDeleteSavedSearch={async (id) => {
            await apiRequest(`/org/saved-searches/${id}`, { method: 'DELETE' });
            await refreshMetadata();
          }}
          onClearSearchHistory={async () => {
            await apiRequest('/org/search/history', { method: 'DELETE' });
            setSearchHistory([]);
          }}
          isSyncing={isSyncing}
          onSyncNow={async () => {
            setIsSyncing(true);
            try {
              for (const a of accounts) {
                await apiRequest(`/accounts/${a.id}/sync`, { method: 'POST' });
              }
              await loadThreads();
              await refreshMetadata();
            } finally {
              setIsSyncing(false);
            }
          }}
          isOnline={isOnline}
          pendingOfflineCount={pendingOfflineCount}
          onRetryOfflineQueue={() => void flushOfflineQueue()}
          layoutMode={preferences.appearance.layoutMode}
          onChangeLayoutMode={(mode) => void updatePreferences({ appearance: { layoutMode: mode } })}
          theme={preferences.appearance.theme}
          onToggleTheme={() => {
            const next = preferences.appearance.theme === 'dark' ? 'light' : 'dark';
            void updatePreferences({ appearance: { theme: next } });
          }}
          sidebarCollapsed={preferences.appearance.sidebarCollapsed}
          onToggleSidebarCollapse={() =>
            void updatePreferences({ appearance: { sidebarCollapsed: !preferences.appearance.sidebarCollapsed } })
          }
          onOpenMobileDrawer={() => setMobileDrawerOpen(true)}
          notifications={notifications}
          unreadNotifCount={unreadNotifCount}
          onMarkAllNotifsRead={async () => {
            await apiRequest('/productivity/notifications/read-all', { method: 'POST' });
            await refreshMetadata();
          }}
          onSelectNotificationThread={async (threadId, notifId) => {
            await apiRequest(`/productivity/notifications/${notifId}/read`, { method: 'PATCH' });
            setActiveSection('mail');
            await openThread(threadId);
            await refreshMetadata();
          }}
          aiPanelOpen={aiPanelOpen}
          onToggleAiPanel={() => setAiPanelOpen((v) => !v)}
          onOpenSettings={() => setActiveSection('settings')}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onSelectAccount={setSelectedAccountId}
        />

        {/* Workspace Main Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <main style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
            {activeSection === 'mail' && (
              <div style={layoutGridStyle}>
                {showListPane && (
                  <div
                    style={{
                      borderRight:
                        effectiveLayoutMode === 'split-right' ? '1px solid var(--border-hairline)' : undefined,
                      borderBottom:
                        effectiveLayoutMode === 'split-bottom' ? '1px solid var(--border-hairline)' : undefined,
                      overflow: 'hidden',
                    }}
                  >
                    <EmailList
                      threads={threads}
                      drafts={drafts}
                      activeView={activeView}
                      activeCategory={activeCategory}
                      categories={categories}
                      counts={counts}
                      folders={folders}
                      labels={labels}
                      accounts={accounts}
                      selectedThreadId={selectedThreadId}
                      selectedIds={selectedIds}
                      loading={listLoading}
                      error={listError}
                      isOnline={isOnline}
                      sortBy={preferences.inbox.sortBy}
                      unreadOnly={unreadOnly}
                      hasAttachmentOnly={hasAttachmentOnly}
                      searchQuery={searchQuery}
                      highlightTerms={highlightTerms}
                      searchMeta={searchMeta}
                      includeRemoteSearch={includeRemoteSearch}
                      onToggleRemoteSearch={() => setIncludeRemoteSearch((v) => !v)}
                      onSelectCategory={(slug) => setActiveCategory(slug)}
                      onSelectThread={(id) => void openThread(id)}
                      onToggleSelectId={(id, shiftKey) => {
                        const idx = threads.findIndex((t) => t.id === id);
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (shiftKey && lastClickedIdxRef.current !== null && idx !== -1) {
                            const [lo, hi] = [Math.min(lastClickedIdxRef.current, idx), Math.max(lastClickedIdxRef.current, idx)];
                            for (let i = lo; i <= hi; i++) next.add(threads[i].id);
                          } else {
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                          }
                          return next;
                        });
                        lastClickedIdxRef.current = idx;
                      }}
                      onSelectAll={() => setSelectedIds(new Set(threads.map((t) => t.id)))}
                      onClearSelection={() => setSelectedIds(new Set())}
                      onBulkAction={(ids, act, extra) => void handleBulkAction(ids, act, extra)}
                      onChangeSort={(sort) => void updatePreferences({ inbox: { sortBy: sort } })}
                      onToggleUnreadFilter={() => setUnreadOnly((v) => !v)}
                      onToggleAttachmentFilter={() => setHasAttachmentOnly((v) => !v)}
                      onClearSearch={() => {
                        setSearchQuery('');
                        setActiveView('inbox');
                      }}
                      onOpenDraft={(d) => {
                        setComposerWindows((prev) => {
                          if (prev.some((w) => w.draft.id === d.id)) return prev;
                          return [...prev, { localKey: d.id, draft: d, minimized: false, maximized: false }];
                        });
                      }}
                      onCancelScheduled={async (draftId) => {
                        await apiRequest(`/drafts/${draftId}/cancel-schedule`, { method: 'POST' });
                        await loadThreads();
                      }}
                      onDiscardDraft={async (draftId) => {
                        await apiRequest(`/drafts/${draftId}`, { method: 'DELETE' });
                        await loadThreads();
                      }}
                      onSyncNow={() => void loadThreads()}
                      onReconnectAccount={() => setActiveSection('settings')}
                      onConnectRealEmail={() => setConnectModalOpen(true)}
                      onReplyThread={async (threadId, mode) => {
                        const detail = await apiRequest<{ messages: EmailMessage[] }>(`/threads/${threadId}`);
                        const last = detail.messages[detail.messages.length - 1];
                        if (last) void openComposer({ mode, replyToMessage: last });
                      }}
                      totalCount={totalThreads}
                      loadingMore={loadingMore}
                      onLoadMore={() => void loadMoreThreads()}
                      onEmptyFolder={async (folder) => {
                        const res = await apiRequest<{ deletedMessages: number }>('/threads/folder/empty', {
                          method: 'POST',
                          body: {
                            folder,
                            ...(selectedAccountId !== 'all' ? { accountId: selectedAccountId } : {}),
                          },
                        });
                        setSelectedIds(new Set());
                        setSelectedThreadId(null);
                        setActiveThread(null);
                        setActiveMessages([]);
                        setToast({
                          message:
                            res.deletedMessages > 0
                              ? `Permanently emptied ${res.deletedMessages} message(s) from ${folder}.`
                              : `${folder.charAt(0).toUpperCase() + folder.slice(1)} is already empty.`,
                        });
                        await loadThreads();
                        await refreshMetadata();
                      }}
                      dateFormat={preferences.general.dateFormat}
                      timeFormat={preferences.general.timeFormat}
                      density={preferences.appearance.density}
                    />
                  </div>
                )}

                {showReadingPane && (
                  <ReadingPane
                    thread={activeThread}
                    account={accounts.find((a) => a.id === activeThread?.accountId) || null}
                    messages={activeMessages}
                    loading={threadLoading}
                    folders={folders}
                    labels={labels}
                    preferences={preferences}
                    onBackToList={
                      effectiveLayoutMode === 'list' || effectiveLayoutMode === 'full-reading'
                        ? () => {
                            setSelectedThreadId(null);
                            setActiveThread(null);
                          }
                        : undefined
                    }
                    onReply={(msg, mode, prefillHtml) => void openComposer({ mode, replyToMessage: msg, prefillBodyHtml: prefillHtml })}
                    onQuickReplySend={async (msg, mode, bodyText) => {
                      const acct = accounts.find((a) => a.id === msg.accountId) || accounts[0];
                      if (!acct) return;
                      const to = [{ name: msg.fromName, address: msg.fromAddress }];
                      const cc =
                        mode === 'reply_all'
                          ? [...msg.to, ...msg.cc].filter((p) => p.address.toLowerCase() !== acct.emailAddress.toLowerCase())
                          : [];
                      const subject = msg.subject.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject}`;
                      const bodyHtml = `<p>${bodyText
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/\n/g, '<br>')}</p>`;
                      const created = await apiRequest<{ draft: Draft }>('/drafts', {
                        method: 'POST',
                        body: {
                          accountId: acct.id,
                          threadId: msg.threadId,
                          replyToMessageId: msg.id,
                          mode,
                          to,
                          cc,
                          subject,
                          bodyHtml,
                          bodyText,
                          isPlainText: false,
                        },
                      });
                      const sentRes = await apiRequest<{ status: string; undoSendUntil?: string }>(`/drafts/${created.draft.id}/send`, {
                        method: 'POST',
                        body: { undoDelaySeconds: preferences.email.undoSendDelaySeconds },
                      });
                      if (sentRes.undoSendUntil) {
                        setToast({
                          message: 'Quick reply queued to send',
                          undoDraftId: created.draft.id,
                          expiresAt: new Date(sentRes.undoSendUntil).getTime(),
                        });
                      } else {
                        setToast({ message: 'Reply sent.' });
                        await openThread(msg.threadId);
                      }
                      await loadThreads();
                    }}
                    onBulkAction={(act, extra) => activeThread && void handleBulkAction([activeThread.id], act, extra)}
                    onReportPhishing={async (threadId, block) => {
                      await apiRequest(`/threads/${threadId}/report-phishing`, {
                        method: 'POST',
                        body: { blockSender: block },
                      });
                      setToast({ message: 'Reported phishing and moved to Spam.' });
                      setSelectedThreadId(null);
                      setActiveThread(null);
                      await loadThreads();
                    }}
                    onBlockSender={async (email) => {
                      await apiRequest('/threads/block-sender', { method: 'POST', body: { emailOrDomain: email } });
                      setToast({ message: `Blocked sender ${email}` });
                      setSelectedThreadId(null);
                      setActiveThread(null);
                      await loadThreads();
                    }}
                    onCreateReminder={async (threadId, messageId, title, dueAt) => {
                      await apiRequest('/productivity/reminders', {
                        method: 'POST',
                        body: { threadId, messageId, title, dueAt },
                      });
                      setToast({ message: 'Follow-up reminder scheduled.' });
                      await refreshMetadata();
                    }}
                    categories={categories}
                    onCreateTask={async (threadId, messageId, title, dueAt) => {
                      await apiRequest('/workspace/tasks', {
                        method: 'POST',
                        body: { threadId, messageId, title, dueAt },
                      });
                      setToast({ message: `Task "${title}" added.` });
                      await refreshMetadata();
                    }}
                    onExtractEvent={async (threadId) => {
                      const res = await apiRequest<{
                        candidate: {
                          title: string;
                          description: string;
                          location: string;
                          meetingUrl: string;
                          startAt: string;
                          endAt: string;
                          attendees: Array<{ name: string; address: string }>;
                        };
                      }>(`/workspace/calendar/extract-from-thread/${threadId}`, { method: 'POST' });
                      return res.candidate;
                    }}
                    onSaveEvent={async (payload) => {
                      await apiRequest('/workspace/calendar', {
                        method: 'POST',
                        body: payload,
                      });
                      setToast({ message: `Event "${payload.title}" added to Calendar.` });
                    }}
                    onCreateRuleFromSender={(fromAddress, subject) => {
                      setRulePrefill({ fromAddress, subject });
                      setActiveSection('rules');
                    }}
                    onUnsubscribeMailto={(mailtoAddress, subject) => {
                      void openComposer({
                        prefillTo: [{ name: '', address: mailtoAddress }],
                        prefillSubject: `Unsubscribe: ${subject}`,
                      });
                    }}
                    onOpenAiForThread={() => setAiPanelOpen(true)}
                    hasThreads={threads.length > 0 || listLoading}
                    accounts={accounts}
                    onCompose={() => void openComposer()}
                    onConnectRealEmail={() => setConnectModalOpen(true)}
                    onOpenShortcuts={() => setShortcutsOpen(true)}
                  />
                )}
              </div>
            )}

            {activeSection === 'contacts' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Contacts...</div>}>
                  <ContactsView
                    onComposeTo={(email, name) => {
                      setActiveSection('mail');
                      void openComposer({ prefillTo: [{ name, address: email }] });
                    }}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'rules' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Rules...</div>}>
                  <RulesView
                    accounts={accounts}
                    folders={folders}
                    labels={labels}
                    categories={categories}
                    onRefreshMail={() => void loadThreads()}
                    initialPrefill={rulePrefill}
                    onConsumePrefill={() => setRulePrefill(null)}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'templates' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Templates...</div>}>
                  <TemplatesView templates={templates} onReload={refreshMetadata} />
                </Suspense>
              </div>
            )}

            {activeSection === 'reminders' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Reminders...</div>}>
                  <RemindersView
                    onOpenThread={(tid) => {
                      setActiveSection('mail');
                      void openThread(tid);
                    }}
                    onCountChange={setPendingReminderCount}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'settings' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Settings...</div>}>
                  <SettingsView
                    preferences={preferences}
                    accounts={accounts}
                    categories={categories}
                    onUpdatePreferences={updatePreferences}
                    onRefreshAll={async () => {
                      await refreshMetadata();
                      await loadThreads();
                    }}
                    onLogout={async () => {
                      await apiRequest('/auth/logout', { method: 'POST' });
                      setAuthState('unauthenticated');
                      setUser(null);
                    }}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'admin' && user?.role === 'admin' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Infrastructure Admin...</div>}>
                  <AdminConsoleView
                    onRefreshAccounts={async () => {
                      await refreshMetadata();
                      await loadThreads();
                    }}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'tasks' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Tasks...</div>}>
                  <TasksView
                    onOpenThread={(tid) => {
                      setActiveSection('mail');
                      void openThread(tid);
                    }}
                    onCountChange={setOpenTaskCount}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'calendar' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Calendar...</div>}>
                  <CalendarView
                    onOpenThread={(tid) => {
                      setActiveSection('mail');
                      void openThread(tid);
                    }}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'attachments' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Attachment Library...</div>}>
                  <AttachmentsView
                    accounts={accounts}
                    onOpenThread={(tid) => {
                      setActiveSection('mail');
                      void openThread(tid);
                    }}
                  />
                </Suspense>
              </div>
            )}

            {activeSection === 'collaboration' && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading Team Desk...</div>}>
                  <CollaborationView accounts={accounts} />
                </Suspense>
              </div>
            )}
          </main>

          {aiPanelOpen && (
            <Suspense fallback={null}>
              <AiAssistantPanel
                open={aiPanelOpen}
                onClose={() => setAiPanelOpen(false)}
                thread={activeThread}
                messages={activeMessages}
                preferences={preferences}
                onEnableAiConsent={async () => {
                  await updatePreferences({ ai: { enabled: true, privacyDisclosureAccepted: true } });
                }}
                onInsertReply={(bodyText) => {
                  const last = activeMessages[activeMessages.length - 1];
                  if (last) {
                    void openComposer({
                      mode: 'reply',
                      replyToMessage: last,
                      prefillBodyHtml: `<p>${bodyText.replace(/\n/g, '<br>')}</p>`,
                    });
                  }
                }}
                onCreateReminder={async (threadId, messageId, title, dueAt) => {
                  await apiRequest('/productivity/reminders', {
                    method: 'POST',
                    body: { threadId, messageId, title, dueAt },
                  });
                  setToast({ message: 'Task saved as reminder.' });
                  await refreshMetadata();
                }}
                onCreateTask={async (threadId, messageId, title, dueAt) => {
                  await apiRequest('/workspace/tasks', {
                    method: 'POST',
                    body: { threadId, messageId, title, dueAt },
                  });
                  setToast({ message: `Task "${title}" created.` });
                  await refreshMetadata();
                }}
                onOpenThread={(tid) => {
                  setActiveSection('mail');
                  void openThread(tid);
                }}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* Multi-Window Composer Dock */}
      {composerWindows.length > 0 && (
        <Suspense fallback={null}>
          <ComposerDock
            windows={composerWindows}
            accounts={accounts}
            templates={templates}
            preferences={preferences}
            onUpdateWindow={(key, patch) =>
              setComposerWindows((prev) => prev.map((w) => (w.localKey === key ? { ...w, ...patch } : w)))
            }
            onCloseWindow={(key) => setComposerWindows((prev) => prev.filter((w) => w.localKey !== key))}
            onDraftSaved={(key, updatedDraft) =>
              setComposerWindows((prev) => prev.map((w) => (w.localKey === key ? { ...w, draft: updatedDraft } : w)))
            }
            onDraftSent={(key, draftId, undoUntil) => {
              setComposerWindows((prev) => prev.filter((w) => w.localKey !== key));
              if (undoUntil) {
                setToast({ message: 'Message queued to send', undoDraftId: draftId, expiresAt: new Date(undoUntil).getTime() });
              } else {
                setToast({ message: 'Message sent successfully.' });
              }
              void loadThreads();
            }}
            onError={(msg) => setToast({ message: msg })}
          />
        </Suspense>
      )}

      {/* Undo Send / Feedback Toast */}
      {toast && (
        <div
          role="status"
          className="no-print"
          style={{
            position: 'fixed',
            bottom: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 90,
            background: 'var(--text-primary)',
            color: 'var(--bg-canvas)',
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 13,
          }}
        >
          <span>
            {toast.message}
            {toast.undoDraftId && toastSecondsLeft > 0 ? ` (${toastSecondsLeft}s)` : ''}
          </span>
          {toast.undoDraftId && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={async () => {
                const res = await apiRequest<{ draft: Draft }>(`/drafts/${toast.undoDraftId}/cancel-undo`, {
                  method: 'POST',
                });
                setToast({ message: 'Send cancelled — draft restored.' });
                setComposerWindows((prev) => [
                  ...prev,
                  { localKey: res.draft.id, draft: res.draft, minimized: false, maximized: false },
                ]);
              }}
            >
              Undo Send
            </button>
          )}
          {toast.undoThreadAction && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={async () => {
                const targetIds = toast.undoThreadAction!.threadIds;
                setToast(null);
                await apiRequest('/threads/bulk', {
                  method: 'POST',
                  body: { threadIds: targetIds, action: 'restore' },
                });
                await loadThreads();
                await refreshMetadata();
                setToast({ message: 'Restored to Inbox.' });
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            style={{ border: 'none', background: 'transparent', color: 'inherit', padding: 0, display: 'inline-flex' }}
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Connect Real Email Modal */}
      {connectModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Connect real email account"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 95,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
          onClick={() => setConnectModalOpen(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 660,
              maxHeight: '90vh',
              overflowY: 'auto',
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-xl)',
              padding: 22,
              boxShadow: 'var(--shadow-lg)',
              border: '1px solid var(--border-strong)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ fontSize: 16 }}>Connect Your Real Email</strong>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  Sync &amp; send real email through Gmail, Outlook, Yahoo, iCloud, or any IMAP/SMTP server.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setConnectModalOpen(false)}
                aria-label="Close connect email modal"
              >
                <X size={15} />
              </button>
            </div>
            <Suspense fallback={<div style={{ padding: 20, color: 'var(--text-muted)' }}>Loading connector...</div>}>
              <ConnectRealMailPanel
                defaultName={user?.name || ''}
                compact
                onOpenAdmin={
                  user?.role === 'admin'
                    ? () => {
                        setConnectModalOpen(false);
                        setActiveSection('admin');
                      }
                    : undefined
                }
                onConnected={async () => {
                  setConnectModalOpen(false);
                  await refreshMetadata();
                  await loadThreads();
                  setToast({ message: 'Real mailbox connected and synchronized.' });
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Modal */}
      {shortcutsOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 95,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 440,
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-xl)',
              padding: 22,
              boxShadow: 'var(--shadow-lg)',
              border: '1px solid var(--border-strong)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <strong style={{ fontSize: 15 }}>Keyboard Shortcuts</strong>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShortcutsOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 16px', fontSize: 13 }}>
              {[
                ['Next / Previous conversation', 'j / k'],
                ['Compose new message', 'c'],
                ['Focus global search', '/'],
                ['Reply / Reply All / Forward', 'r / a / f'],
                ['Archive conversation', 'e'],
                ['Toggle star', 's'],
                ['Delete conversation', '#'],
                ['Show shortcuts', '?'],
              ].map(([label, keys]) => (
                <React.Fragment key={label}>
                  <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                  <span className="kbd">{keys}</span>
                </React.Fragment>
              ))}
            </div>
            {user && (
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-hairline)', fontSize: 12, color: 'var(--text-muted)' }}>
                Signed in as {user.name} ({user.email})
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
