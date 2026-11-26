import React, { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CalendarClock,
  Eraser,
  FileText,
  Highlighter,
  ImagePlus,
  Indent,
  Italic,
  Link2,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  Outdent,
  Paperclip,
  Quote,
  Redo2,
  RefreshCw,
  Send,
  Sparkles,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from 'lucide-react';
import { apiRequest } from '../api/client';
import type { Account, AccountSignature, Draft, EmailParticipant, Template, UserPreferences } from '../types';
import { formatBytes } from './CadenceMark';

export interface ComposerWindowState {
  localKey: string;
  draft: Draft;
  minimized: boolean;
  maximized: boolean;
}

interface ComposerDockProps {
  windows: ComposerWindowState[];
  accounts: Account[];
  templates: Template[];
  preferences: UserPreferences;
  onUpdateWindow: (localKey: string, patch: Partial<ComposerWindowState>) => void;
  onCloseWindow: (localKey: string) => void;
  onDraftSaved: (localKey: string, draft: Draft) => void;
  onDraftSent: (localKey: string, draftId: string, undoUntil?: string) => void;
  onError: (msg: string) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RecipientChipInput({
  label,
  values,
  onChange,
  onSearchSuggest,
}: {
  label: string;
  values: EmailParticipant[];
  onChange: (next: EmailParticipant[]) => void;
  onSearchSuggest: (q: string) => Promise<{
    suggestions: Array<{ id: string; name: string; email: string }>;
    groups: Array<{ id: string; name: string; members: Array<{ name: string; email: string }> }>;
  }>;
}) {
  const [input, setInput] = useState('');
  const [warning, setWarning] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [groupSuggs, setGroupSuggs] = useState<Array<{ id: string; name: string; members: Array<{ name: string; email: string }> }>>([]);
  const [open, setOpen] = useState(false);

  async function handleInputChange(val: string) {
    setInput(val);
    setWarning('');
    if (val.trim().length >= 1) {
      const res = await onSearchSuggest(val.trim());
      setSuggestions(res.suggestions);
      setGroupSuggs(res.groups);
      setOpen(true);
    } else {
      setOpen(false);
    }
  }

  function addAddress(raw: string, name = '') {
    const clean = raw.trim().toLowerCase();
    if (!clean) return;
    if (!EMAIL_RE.test(clean)) {
      setWarning(`Invalid email address: ${raw}`);
      return;
    }
    if (values.some((v) => v.address.toLowerCase() === clean)) {
      setWarning(`Duplicate recipient skipped: ${clean}`);
      setInput('');
      return;
    }
    onChange([...values, { name, address: clean }]);
    setInput('');
    setWarning('');
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 5,
          padding: '5px 10px',
          borderBottom: '1px solid var(--border-hairline)',
          minHeight: 36,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 34 }}>{label}</span>
        {values.map((r) => (
          <span key={r.address} className="chip" style={{ gap: 4 }}>
            <span>{r.name ? `${r.name} <${r.address}>` : r.address}</span>
            <button
              type="button"
              style={{ border: 'none', background: 'transparent', padding: 0, display: 'inline-flex', color: 'inherit' }}
              onClick={() => onChange(values.filter((v) => v.address !== r.address))}
              aria-label={`Remove ${r.address}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          style={{
            flex: 1,
            minWidth: 130,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontSize: 13,
          }}
          placeholder="Add recipient..."
          value={input}
          onChange={(e) => void handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              if (input.trim()) {
                e.preventDefault();
                addAddress(input.replace(/,$/, ''));
              }
            } else if (e.key === 'Backspace' && !input && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => {
            setTimeout(() => setOpen(false), 180);
            if (input.trim()) addAddress(input);
          }}
        />
      </div>

      {warning && (
        <div style={{ padding: '3px 10px', fontSize: 11.5, color: 'var(--status-warning)', background: 'var(--status-warning-bg)' }}>
          {warning}
        </div>
      )}

      {open && (suggestions.length > 0 || groupSuggs.length > 0) && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 36,
            right: 12,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 70,
            padding: 4,
          }}
        >
          {suggestions.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ width: '100%', justifyContent: 'space-between' }}
              onMouseDown={(e) => {
                e.preventDefault();
                addAddress(c.email, c.name);
              }}
            >
              <strong>{c.name}</strong>
              <span style={{ color: 'var(--text-muted)' }}>{c.email}</span>
            </button>
          ))}
          {groupSuggs.map((g) => (
            <button
              key={g.id}
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ width: '100%', justifyContent: 'space-between' }}
              onMouseDown={(e) => {
                e.preventDefault();
                const merged = [...values];
                for (const m of g.members) {
                  if (!merged.some((v) => v.address.toLowerCase() === m.email.toLowerCase())) {
                    merged.push({ name: m.name, address: m.email });
                  }
                }
                onChange(merged);
                setInput('');
                setOpen(false);
              }}
            >
              <span>Group: {g.name}</span>
              <span className="tabular" style={{ color: 'var(--text-muted)' }}>{g.members.length} members</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SingleComposerWindow({
  win,
  accounts,
  templates,
  preferences,
  onUpdateWindow,
  onCloseWindow,
  onDraftSaved,
  onDraftSent,
  onError,
}: {
  win: ComposerWindowState;
  accounts: Account[];
  templates: Template[];
  preferences: UserPreferences;
  onUpdateWindow: (localKey: string, patch: Partial<ComposerWindowState>) => void;
  onCloseWindow: (localKey: string) => void;
  onDraftSaved: (localKey: string, draft: Draft) => void;
  onDraftSent: (localKey: string, draftId: string, undoUntil?: string) => void;
  onError: (msg: string) => void;
}) {
  const { draft } = win;
  const [accountId, setAccountId] = useState(draft.accountId);
  const [to, setTo] = useState<EmailParticipant[]>(draft.to);
  const [cc, setCc] = useState<EmailParticipant[]>(draft.cc);
  const [bcc, setBcc] = useState<EmailParticipant[]>(draft.bcc);
  const [showCcBcc, setShowCcBcc] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [isPlainText, setIsPlainText] = useState(draft.isPlainText);
  const [plainTextBody, setPlainTextBody] = useState(draft.bodyText || '');
  const [attachments, setAttachments] = useState(draft.attachments || []);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved');
  const [sending, setSending] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(() => new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
  const [scheduleTz, setScheduleTz] = useState(preferences.general.timezone || 'UTC');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [accountSignatures, setAccountSignatures] = useState<AccountSignature[]>([]);
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiTone, setAiTone] = useState(preferences.ai.defaultTone);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiGeneratedBadge, setAiGeneratedBadge] = useState(false);
  const [lastAiAction, setLastAiAction] = useState<'generate' | 'rewrite' | 'grammar' | 'shorten' | 'expand' | 'tone'>('generate');
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkUrlInput, setLinkUrlInput] = useState('https://');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inlineImgRef = useRef<HTMLInputElement>(null);
  const versionRef = useRef(draft.version);
  const autosaveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const persistLatestRef = useRef<() => Promise<void>>(async () => {});
  const aiAbortRef = useRef<AbortController | null>(null);
  const lastSigHtmlRef = useRef<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      FontFamily,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      Image.configure({ inline: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: draft.bodyHtml || '',
    onUpdate: () => {
      scheduleAutosave();
    },
  });

  function scheduleAutosave() {
    dirtyRef.current = true;
    setSaveState('dirty');
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      void persistDraft();
    }, 650);
  }

  async function persistDraft(override?: Partial<{ to: EmailParticipant[]; cc: EmailParticipant[]; bcc: EmailParticipant[]; subject: string; accountId: string; isPlainText: boolean; plainTextBody: string }>) {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setSaveState('saving');
    try {
      const html = isPlainText ? '' : editor?.getHTML() || '';
      const text = isPlainText ? (override?.plainTextBody ?? plainTextBody) : editor?.getText() || '';
      const res = await apiRequest<{ draft: Draft }>(`/drafts/${draft.id}`, {
        method: 'PATCH',
        body: {
          accountId: override?.accountId ?? accountId,
          to: override?.to ?? to,
          cc: override?.cc ?? cc,
          bcc: override?.bcc ?? bcc,
          subject: override?.subject ?? subject,
          bodyHtml: html,
          bodyText: text,
          isPlainText: override?.isPlainText ?? isPlainText,
          expectedVersion: versionRef.current,
        },
      });
      versionRef.current = res.draft.version;
      dirtyRef.current = false;
      onDraftSaved(win.localKey, res.draft);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  persistLatestRef.current = () => persistDraft();

  useEffect(() => {
    let active = true;
    apiRequest<{ signatures: AccountSignature[] }>(`/workspace/signatures?accountId=${encodeURIComponent(accountId)}`)
      .then((res) => {
        if (active) setAccountSignatures(res.signatures || []);
      })
      .catch(() => {
        if (active) setAccountSignatures([]);
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (dirtyRef.current) {
        void persistLatestRef.current();
      }
      if (aiAbortRef.current) {
        aiAbortRef.current.abort();
      }
    };
  }, []);

  async function handleSend() {
    if (to.length + cc.length + bcc.length === 0) {
      onError('Please add at least one valid recipient.');
      return;
    }
    setSending(true);
    try {
      await persistDraft();
      const res = await apiRequest<{ status: string; undoSendUntil?: string }>(`/drafts/${draft.id}/send`, {
        method: 'POST',
        body: { undoDelaySeconds: preferences.email.undoSendDelaySeconds },
      });
      onDraftSent(win.localKey, draft.id, res.undoSendUntil);
    } catch (err: any) {
      onError(err?.message || 'Failed to send message');
      setSending(false);
    }
  }

  async function handleSchedule() {
    if (to.length + cc.length + bcc.length === 0) {
      onError('Please add at least one valid recipient.');
      return;
    }
    setSending(true);
    try {
      await persistDraft();
      await apiRequest(`/drafts/${draft.id}/schedule`, {
        method: 'POST',
        body: { scheduledFor: new Date(scheduleDate).toISOString(), timezone: scheduleTz },
      });
      onDraftSent(win.localKey, draft.id);
    } catch (err: any) {
      onError(err?.message || 'Failed to schedule email');
      setSending(false);
    }
  }

  async function handleFileUpload(files: FileList | null, inline = false) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > 15 * 1024 * 1024) {
        onError(`"${file.name}" exceeds the 15 MB attachment limit.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const result = String(reader.result || '');
        const b64 = result.split(',')[1] || '';
        if (inline && file.type.startsWith('image/') && editor) {
          editor.chain().focus().setImage({ src: result, alt: file.name }).run();
          scheduleAutosave();
          return;
        }
        try {
          const res = await apiRequest<{ attachment: any }>(`/drafts/${draft.id}/attachments`, {
            method: 'POST',
            body: {
              filename: file.name,
              mimeType: file.type || 'application/octet-stream',
              contentBase64: b64,
            },
          });
          setAttachments((prev) => [...prev, res.attachment]);
        } catch (err: any) {
          onError(err?.message || 'Attachment upload failed');
        }
      };
      reader.readAsDataURL(file);
    }
  }

  async function runAiAction(action: 'generate' | 'rewrite' | 'grammar' | 'shorten' | 'expand' | 'tone') {
    if (aiAbortRef.current) aiAbortRef.current.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setLastAiAction(action);
    setAiBusy(true);
    try {
      const currentText = isPlainText ? plainTextBody : editor?.getText() || '';
      const res = await apiRequest<{ text: string; provider?: string }>('/productivity/ai/transform', {
        method: 'POST',
        signal: controller.signal,
        body: {
          action,
          instructions: aiInstruction,
          content: currentText,
          tone: aiTone,
        },
      });
      if (controller.signal.aborted) return;
      if (isPlainText) {
        setPlainTextBody(res.text);
      } else if (editor) {
        const htmlParas = res.text
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
          .join('');
        editor.commands.setContent(htmlParas);
      }
      setAiGeneratedBadge(true);
      scheduleAutosave();
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      onError(err?.message || 'AI Assistant unavailable — check Settings -> AI & Privacy');
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      setAiBusy(false);
    }
  }

  if (win.minimized) {
    return (
      <div
        style={{
          width: 260,
          height: 38,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderBottom: 'none',
          borderRadius: '10px 10px 0 0',
          boxShadow: 'var(--shadow-md)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
        }}
      >
        <button
          type="button"
          onClick={() => onUpdateWindow(win.localKey, { minimized: false })}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            textAlign: 'left',
            fontWeight: 600,
            fontSize: 12.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-primary)',
          }}
        >
          {subject || 'New Message'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          style={{ width: 24, height: 24 }}
          onClick={() => onCloseWindow(win.localKey)}
          aria-label="Close draft"
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  const windowStyle: React.CSSProperties = win.maximized
    ? {
        position: 'fixed',
        inset: '24px',
        zIndex: 75,
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-strong)',
        background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }
    : {
        width: 'min(580px, calc(100vw - 24px))',
        height: 'min(580px, calc(100vh - 80px))',
        borderRadius: '12px 12px 0 0',
        border: '1px solid var(--border-strong)',
        borderBottom: 'none',
        background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      };

  return (
    <div className={win.maximized ? '' : 'cadence-composer-window'} style={windowStyle} role="dialog" aria-label="Compose email">
      {/* Header */}
      <div
        style={{
          height: 40,
          padding: '0 12px',
          background: 'var(--bg-chrome)',
          borderBottom: '1px solid var(--border-hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subject || 'New Message'}
          </strong>
          <span style={{ fontSize: 11, color: saveState === 'error' ? 'var(--status-danger)' : 'var(--text-muted)' }}>
            {saveState === 'saving' ? 'Saving...' : saveState === 'dirty' ? 'Unsaved' : saveState === 'error' ? 'Save error' : 'Saved'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => onUpdateWindow(win.localKey, { minimized: true })}
            title="Minimize"
            aria-label="Minimize composer"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => onUpdateWindow(win.localKey, { maximized: !win.maximized })}
            title={win.maximized ? 'Restore size' : 'Maximize'}
            aria-label="Toggle maximize"
          >
            {win.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={async () => {
              if (dirtyRef.current) await persistDraft();
              onCloseWindow(win.localKey);
            }}
            title="Close (draft stays saved)"
            aria-label="Close composer"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* From + Recipients + Subject */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px', borderBottom: '1px solid var(--border-hairline)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 34 }}>From</span>
            <select
              aria-label="Sending account"
              style={{ border: 'none', background: 'transparent', fontSize: 12.5, outline: 'none', color: 'var(--text-primary)' }}
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                void persistDraft({ accountId: e.target.value });
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} &lt;{a.emailAddress}&gt;
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {accountSignatures.length > 0 && !isPlainText && editor && (
              <select
                aria-label="Apply signature"
                className="btn btn-ghost btn-sm"
                style={{ height: 22, fontSize: 11.5, padding: '0 4px', maxWidth: 130 }}
                defaultValue=""
                onChange={(e) => {
                  const sig = accountSignatures.find((s) => s.id === e.target.value);
                  if (!sig) return;
                  const existingHtml = editor.getHTML();
                  const marker = '<p>--</p>';
                  const markerIdx = existingHtml.lastIndexOf(marker);
                  const baseHtml =
                    markerIdx >= 0 && lastSigHtmlRef.current ? existingHtml.slice(0, markerIdx) : existingHtml;
                  lastSigHtmlRef.current = sig.bodyHtml;
                  editor.commands.setContent(`${baseHtml}${marker}${sig.bodyHtml}`);
                  scheduleAutosave();
                  e.target.value = '';
                }}
              >
                <option value="" disabled>Signature</option>
                {accountSignatures.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{s.isDefault ? ' *' : ''}</option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ height: 22, fontSize: 11.5 }}
              onClick={() => setShowCcBcc((v) => !v)}
            >
              {showCcBcc ? 'Hide CC/BCC' : 'CC / BCC'}
            </button>
          </div>
        </div>

        <RecipientChipInput
          label="To"
          values={to}
          onChange={(next) => {
            setTo(next);
            scheduleAutosave();
          }}
          onSearchSuggest={(q) => apiRequest(`/productivity/contacts/suggest?q=${encodeURIComponent(q)}`)}
        />

        {showCcBcc && (
          <>
            <RecipientChipInput
              label="CC"
              values={cc}
              onChange={(next) => {
                setCc(next);
                scheduleAutosave();
              }}
              onSearchSuggest={(q) => apiRequest(`/productivity/contacts/suggest?q=${encodeURIComponent(q)}`)}
            />
            <RecipientChipInput
              label="BCC"
              values={bcc}
              onChange={(next) => {
                setBcc(next);
                scheduleAutosave();
              }}
              onSearchSuggest={(q) => apiRequest(`/productivity/contacts/suggest?q=${encodeURIComponent(q)}`)}
            />
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderBottom: '1px solid var(--border-hairline)', height: 36 }}>
          <input
            aria-label="Email subject"
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13.5, fontWeight: 500 }}
            placeholder="Subject"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              scheduleAutosave();
            }}
          />
        </div>
      </div>

      {/* Rich Text Formatting Toolbar */}
      {!isPlainText && editor && (
        <div
          style={{
            padding: '5px 8px',
            borderBottom: '1px solid var(--border-hairline)',
            background: 'var(--bg-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            flexWrap: 'wrap',
            position: 'relative',
          }}
        >
          <button type="button" className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} onClick={() => editor.chain().focus().undo().run()} title="Undo" aria-label="Undo">
            <Undo2 size={13} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} onClick={() => editor.chain().focus().redo().run()} title="Redo" aria-label="Redo">
            <Redo2 size={13} />
          </button>
          <select
            aria-label="Heading level"
            className="field"
            style={{ width: 'auto', height: 24, padding: '0 6px', fontSize: 11.5 }}
            value={
              editor.isActive('heading', { level: 1 })
                ? 'h1'
                : editor.isActive('heading', { level: 2 })
                ? 'h2'
                : editor.isActive('heading', { level: 3 })
                ? 'h3'
                : 'p'
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'p') editor.chain().focus().setParagraph().run();
              else if (v === 'h1') editor.chain().focus().setHeading({ level: 1 }).run();
              else if (v === 'h2') editor.chain().focus().setHeading({ level: 2 }).run();
              else if (v === 'h3') editor.chain().focus().setHeading({ level: 3 }).run();
            }}
          >
            <option value="p">Body</option>
            <option value="h1">Title</option>
            <option value="h2">Heading</option>
            <option value="h3">Subheading</option>
          </select>
          <select
            aria-label="Font family"
            className="field"
            style={{ width: 'auto', height: 24, padding: '0 6px', fontSize: 11.5 }}
            defaultValue=""
            onChange={(e) => {
              if (!e.target.value) editor.chain().focus().unsetFontFamily().run();
              else editor.chain().focus().setFontFamily(e.target.value).run();
            }}
          >
            <option value="">Sans (Onest)</option>
            <option value="Georgia, serif">Serif</option>
            <option value="JetBrains Mono, monospace">Monospace</option>
          </select>
          <button
            type="button"
            className={`btn btn-icon ${editor.isActive('bold') ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
            aria-label="Bold"
          >
            <Bold size={13} />
          </button>
          <button
            type="button"
            className={`btn btn-icon ${editor.isActive('italic') ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
            aria-label="Italic"
          >
            <Italic size={13} />
          </button>
          <button
            type="button"
            className={`btn btn-icon ${editor.isActive('underline') ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            title="Underline"
            aria-label="Underline"
          >
            <UnderlineIcon size={13} />
          </button>
          <button
            type="button"
            className={`btn btn-icon ${editor.isActive('strike') ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
            aria-label="Strikethrough"
          >
            <Strikethrough size={13} />
          </button>
          <input
            type="color"
            aria-label="Text color"
            title="Text color"
            defaultValue="#11141B"
            onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            style={{ width: 24, height: 24, border: '1px solid var(--border-hairline)', borderRadius: 4, padding: 1, background: 'transparent', cursor: 'pointer' }}
          />
          <button
            type="button"
            className={`btn btn-icon ${editor.isActive('highlight') ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleHighlight({ color: '#FEF08A' }).run()}
            title="Highlight text"
            aria-label="Highlight text"
          >
            <Highlighter size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet list"
            aria-label="Bullet list"
          >
            <List size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Numbered list"
            aria-label="Numbered list"
          >
            <ListOrdered size={13} />
          </button>
          <button
            type="button"
            className={`btn btn-icon ${editor.isActive('blockquote') ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            title="Quote block"
            aria-label="Quote block"
          >
            <Quote size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().sinkListItem('listItem').run()}
            title="Indent list item"
            aria-label="Indent"
          >
            <Indent size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().liftListItem('listItem').run()}
            title="Outdent list item"
            aria-label="Outdent"
          >
            <Outdent size={13} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} onClick={() => editor.chain().focus().setTextAlign('left').run()} title="Align left" aria-label="Align left">
            <AlignLeft size={13} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} onClick={() => editor.chain().focus().setTextAlign('center').run()} title="Align center" aria-label="Align center">
            <AlignCenter size={13} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} onClick={() => editor.chain().focus().setTextAlign('right').run()} title="Align right" aria-label="Align right">
            <AlignRight size={13} />
          </button>
          <button
            type="button"
            className={`btn btn-icon ${linkPopoverOpen ? 'btn-primary' : 'btn-ghost'}`}
            style={{ width: 26, height: 26 }}
            onClick={() => {
              const existing = editor.getAttributes('link').href;
              setLinkUrlInput(typeof existing === 'string' && existing ? existing : 'https://');
              setLinkPopoverOpen((v) => !v);
            }}
            title="Insert link"
            aria-label="Insert link"
          >
            <Link2 size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            title="Insert 3x3 table"
            aria-label="Insert table"
          >
            <TableIcon size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => inlineImgRef.current?.click()}
            title="Insert inline image"
            aria-label="Insert inline image"
          >
            <ImagePlus size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ width: 26, height: 26 }}
            onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
            title="Clear formatting"
            aria-label="Clear formatting"
          >
            <Eraser size={13} />
          </button>

          {linkPopoverOpen && (
            <div
              role="dialog"
              aria-label="Insert hyperlink"
              style={{
                position: 'absolute',
                top: '100%',
                left: 8,
                right: 8,
                zIndex: 70,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-lg)',
                padding: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 4,
              }}
            >
              <input
                aria-label="Link URL"
                className="field"
                style={{ flex: 1, height: 28, fontSize: 12.5 }}
                placeholder="https://example.com"
                value={linkUrlInput}
                onChange={(e) => setLinkUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const trimmed = linkUrlInput.trim();
                    if (!trimmed) return;
                    const normalized = /^(https?:|mailto:)/i.test(trimmed) ? trimmed : `https://${trimmed}`;
                    editor.chain().focus().setLink({ href: normalized }).run();
                    setLinkPopoverOpen(false);
                    scheduleAutosave();
                  } else if (e.key === 'Escape') {
                    setLinkPopoverOpen(false);
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ height: 28 }}
                onClick={() => {
                  const trimmed = linkUrlInput.trim();
                  if (!trimmed) return;
                  const normalized = /^(https?:|mailto:)/i.test(trimmed) ? trimmed : `https://${trimmed}`;
                  editor.chain().focus().setLink({ href: normalized }).run();
                  setLinkPopoverOpen(false);
                  scheduleAutosave();
                }}
              >
                Apply
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ height: 28 }}
                onClick={() => {
                  editor.chain().focus().unsetLink().run();
                  setLinkPopoverOpen(false);
                  scheduleAutosave();
                }}
              >
                Unlink
              </button>
              <button type="button" className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} onClick={() => setLinkPopoverOpen(false)} aria-label="Close link dialog">
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* AI Inline Writing Assist */}
      {aiPromptOpen && (
        <div
          style={{
            padding: 10,
            background: 'var(--accent-soft)',
            borderBottom: '1px solid var(--border-hairline)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              className="field"
              style={{ flex: 1, height: 30, fontSize: 12.5 }}
              placeholder="Instruction (e.g. 'Politely decline Friday meeting and propose Tuesday')"
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
            />
            <select
              className="field"
              style={{ width: 'auto', height: 30, fontSize: 12 }}
              value={aiTone}
              onChange={(e) => setAiTone(e.target.value as any)}
            >
              {['professional', 'formal', 'friendly', 'neutral', 'polite', 'confident', 'concise'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={aiBusy} onClick={() => void runAiAction('generate')}>
              {aiBusy ? 'Working...' : 'Generate'}
            </button>
            <button type="button" className="btn btn-sm" disabled={aiBusy} onClick={() => void runAiAction('rewrite')}>Rewrite</button>
            <button type="button" className="btn btn-sm" disabled={aiBusy} onClick={() => void runAiAction('grammar')}>Fix Grammar</button>
            <button type="button" className="btn btn-sm" disabled={aiBusy} onClick={() => void runAiAction('shorten')}>Shorten</button>
            <button type="button" className="btn btn-sm" disabled={aiBusy} onClick={() => void runAiAction('expand')}>Expand</button>
            {aiBusy ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  aiAbortRef.current?.abort();
                  setAiBusy(false);
                }}
              >
                Cancel
              </button>
            ) : (
              aiGeneratedBadge && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void runAiAction(lastAiAction)}
                    title="Regenerate draft text"
                  >
                    <RefreshCw size={12} /> Regenerate
                  </button>
                  <span className="chip" style={{ height: 22, fontSize: 11, background: 'var(--bg-elevated)', color: 'var(--accent)' }}>
                    AI-generated — review before sending
                  </span>
                </>
              )
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAiPromptOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {/* Body Area */}
      <div
        style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void handleFileUpload(e.dataTransfer.files);
        }}
      >
        {isPlainText ? (
          <textarea
            aria-label="Plain text message body"
            style={{ width: '100%', height: '100%', minHeight: 200, border: 'none', background: 'transparent', outline: 'none', resize: 'none', fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={plainTextBody}
            onChange={(e) => {
              setPlainTextBody(e.target.value);
              scheduleAutosave();
            }}
            placeholder="Write plain-text email..."
          />
        ) : (
          <EditorContent editor={editor} />
        )}

        {/* Attachments pills */}
        {attachments.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {attachments.map((att) => (
              <span key={att.id} className="chip" style={{ gap: 6 }}>
                <Paperclip size={11} />
                <span>{att.filename}</span>
                <span className="tabular" style={{ color: 'var(--text-muted)' }}>({formatBytes(att.sizeBytes)})</span>
                <button
                  type="button"
                  style={{ border: 'none', background: 'transparent', padding: 0, display: 'inline-flex' }}
                  onClick={async () => {
                    await apiRequest(`/drafts/${draft.id}/attachments/${att.id}`, { method: 'DELETE' });
                    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
                  }}
                  aria-label={`Remove ${att.filename}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Schedule Popover */}
      {scheduleOpen && (
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--border-hairline)',
            background: 'var(--bg-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="datetime-local"
              className="field"
              style={{ width: 'auto', height: 30, fontSize: 12 }}
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
            />
            <input
              className="field"
              style={{ width: 150, height: 30, fontSize: 12 }}
              value={scheduleTz}
              onChange={(e) => setScheduleTz(e.target.value)}
              title="Timezone"
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSchedule()} disabled={sending}>
              Schedule Send
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setScheduleOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Discard Confirm */}
      {confirmDiscard && (
        <div
          style={{
            padding: '8px 14px',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 12.5,
          }}
        >
          <span>Discard this draft permanently?</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                await apiRequest(`/drafts/${draft.id}`, { method: 'DELETE' });
                onCloseWindow(win.localKey);
              }}
            >
              Discard
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmDiscard(false)}>Keep</button>
          </div>
        </div>
      )}

      {/* Bottom Action Footer */}
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border-hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="btn btn-primary" onClick={() => void handleSend()} disabled={sending}>
            <Send size={14} />
            <span>{sending ? 'Sending...' : 'Send'}</span>
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setScheduleOpen((v) => !v)}
            title="Schedule send"
            aria-label="Schedule send"
          >
            <CalendarClock size={15} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
            aria-label="Attach file"
          >
            <Paperclip size={15} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setAiPromptOpen((v) => !v)}
            title="AI writing assistant"
            aria-label="AI writing assistant"
          >
            <Sparkles size={15} />
          </button>

          {/* Templates Picker */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setTemplatesOpen((v) => !v)}
              title="Insert template or signature"
              aria-label="Insert template"
            >
              <FileText size={15} />
            </button>
            {templatesOpen && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 36,
                  left: 0,
                  width: 220,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg)',
                  padding: 6,
                  zIndex: 75,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', padding: '3px 8px' }}>Insert Template</div>
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => {
                      const acct = accounts.find((a) => a.id === accountId);
                      const firstRecipient = to[0]?.name || to[0]?.address.split('@')[0] || 'there';
                      const firstName = firstRecipient.split(/\s+/)[0];
                      const today = new Date().toLocaleDateString();
                      const interpolate = (str: string) =>
                        str
                          .replace(/\{\{first_name\}\}/gi, firstName)
                          .replace(/\{\{sender_name\}\}/gi, acct?.displayName || 'Sender')
                          .replace(/\{\{today\}\}/gi, today);
                      if (!subject && tpl.subject) setSubject(interpolate(tpl.subject));
                      if (editor && !isPlainText) editor.chain().focus().insertContent(interpolate(tpl.bodyHtml)).run();
                      setTemplatesOpen(false);
                      scheduleAutosave();
                    }}
                  >
                    {tpl.name}
                  </button>
                ))}
                <div style={{ borderTop: '1px solid var(--border-hairline)', margin: '4px 0' }} />
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', padding: '3px 8px' }}>Insert Signature</div>
                {accountSignatures.length > 0 ? (
                  accountSignatures.map((sig) => (
                    <button
                      key={sig.id}
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                      onClick={() => {
                        if (editor && !isPlainText) {
                          editor.chain().focus().insertContent(sig.bodyHtml).run();
                          scheduleAutosave();
                        }
                        setTemplatesOpen(false);
                      }}
                    >
                      {sig.name}{sig.isDefault ? ' (Default)' : ''}
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => {
                      const acct = accounts.find((a) => a.id === accountId);
                      if (acct?.signatureHtml && editor) {
                        editor.chain().focus().insertContent(acct.signatureHtml).run();
                        scheduleAutosave();
                      }
                      setTemplatesOpen(false);
                    }}
                  >
                    Insert Default Signature
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 11.5 }}
            onClick={() => {
              const nextPlain = !isPlainText;
              if (nextPlain && editor) setPlainTextBody(editor.getText());
              else if (!nextPlain && editor) editor.commands.setContent(`<p>${plainTextBody.replace(/\n/g, '<br>')}</p>`);
              setIsPlainText(nextPlain);
              scheduleAutosave();
            }}
          >
            {isPlainText ? 'Rich text' : 'Plain text'}
          </button>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => setConfirmDiscard(true)}
          title="Discard draft"
          aria-label="Discard draft"
        >
          <Trash2 size={15} />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void handleFileUpload(e.target.files, false);
            e.target.value = '';
          }}
        />
        <input
          ref={inlineImgRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void handleFileUpload(e.target.files, true);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

export function ComposerDock(props: ComposerDockProps) {
  if (props.windows.length === 0) return null;

  return (
    <div
      className="no-print cadence-composer-dock"
      style={{
        position: 'fixed',
        bottom: 0,
        right: 16,
        zIndex: 65,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 12,
        pointerEvents: 'none',
      }}
    >
      {props.windows.map((win) => (
        <div key={win.localKey} style={{ pointerEvents: 'auto' }}>
          <SingleComposerWindow
            win={win}
            accounts={props.accounts}
            templates={props.templates}
            preferences={props.preferences}
            onUpdateWindow={props.onUpdateWindow}
            onCloseWindow={props.onCloseWindow}
            onDraftSaved={props.onDraftSaved}
            onDraftSent={props.onDraftSent}
            onError={props.onError}
          />
        </div>
      ))}
    </div>
  );
}
