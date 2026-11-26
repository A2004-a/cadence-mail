import { useEffect, useRef, useState } from 'react';
import { BellPlus, CheckCircle2, Languages, Lock, RefreshCw, Search, ShieldAlert, Sparkles, X } from 'lucide-react';
import { ApiError, apiRequest } from '../api/client';
import type { AiWorkflowRun, EmailMessage, ThreadSummary, UserPreferences } from '../types';

interface AiAssistantPanelProps {
  open: boolean;
  onClose: () => void;
  thread: ThreadSummary | null;
  messages: EmailMessage[];
  preferences: UserPreferences;
  onEnableAiConsent: () => Promise<void>;
  onInsertReply: (bodyText: string) => void;
  onCreateReminder: (threadId: string, messageId: string, title: string, dueAt: string) => Promise<void>;
  onCreateTask?: (threadId: string, messageId: string, title: string, dueAt: string | null) => Promise<void>;
  onOpenThread?: (threadId: string) => void;
}

interface AiStatusResponse {
  enabledByUser: boolean;
  privacyDisclosureAccepted: boolean;
  redactSensitiveContent: boolean;
  provider: {
    configured: boolean;
    activeProvider: string | null;
    model: string | null;
    setupInstructions: string[];
  };
}

export function AiAssistantPanel(props: AiAssistantPanelProps) {
  const [status, setStatus] = useState<AiStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<{
    summary: string;
    keyPoints: string[];
    decisions: string[];
    requests: string[];
    unansweredQuestions?: string[];
    deadlines: string[];
    tasks: Array<{ title: string; suggestedDueAt: string | null; context: string }>;
  } | null>(null);
  const [replies, setReplies] = useState<Array<{ label: string; body: string }>>([]);
  const [replyTone, setReplyTone] = useState(props.preferences.ai.defaultTone);
  const [targetLang, setTargetLang] = useState(props.preferences.ai.defaultTargetLanguage || 'Spanish');
  const [translateScope, setTranslateScope] = useState<'latest' | 'thread'>('latest');
  const [translatedText, setTranslatedText] = useState('');
  const [savedTasks, setSavedTasks] = useState<Set<number>>(new Set());
  const [panelTab, setPanelTab] = useState<'intel' | 'search' | 'agent'>('intel');
  const [nlQuery, setNlQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{ answer: string; queryUsed: string; usedLlm: boolean; threads: ThreadSummary[] } | null>(null);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentType, setAgentType] = useState<'summarize_and_tasks' | 'extract_calendar_event' | 'prepare_reply'>('summarize_and_tasks');
  const [activeRun, setActiveRun] = useState<AiWorkflowRun | null>(null);
  const [workflowHistory, setWorkflowHistory] = useState<AiWorkflowRun[]>([]);
  const [workflowBanner, setWorkflowBanner] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  async function loadStatus() {
    try {
      const [s, hist] = await Promise.all([
        apiRequest<AiStatusResponse>('/productivity/ai/status'),
        apiRequest<{ runs: AiWorkflowRun[] }>('/productivity/ai/workflow/history'),
      ]);
      setStatus(s);
      setWorkflowHistory(hist.runs || []);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (props.open) {
      void loadStatus();
      setAnalysis(null);
      setReplies([]);
      setTranslatedText('');
      setError('');
      setSavedTasks(new Set());
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [props.open, props.thread?.id]);

  if (!props.open) return null;

  function beginAbortableRequest(): AbortSignal {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
  }

  async function runAnalyze() {
    if (!props.thread) return;
    const signal = beginAbortableRequest();
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<any>('/productivity/ai/analyze-thread', {
        method: 'POST',
        signal,
        body: { threadId: props.thread.id },
      });
      setAnalysis(res);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Failed to analyze thread');
    } finally {
      setLoading(false);
    }
  }

  async function runSmartReplies() {
    if (!props.thread) return;
    const signal = beginAbortableRequest();
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<{ replies: Array<{ label: string; body: string }> }>('/productivity/ai/smart-replies', {
        method: 'POST',
        signal,
        body: { threadId: props.thread.id, tone: replyTone },
      });
      setReplies(res.replies || []);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Failed to generate replies');
    } finally {
      setLoading(false);
    }
  }

  async function runTranslate() {
    if (props.messages.length === 0) return;
    const signal = beginAbortableRequest();
    setLoading(true);
    setError('');
    try {
      const sourceText =
        translateScope === 'thread'
          ? props.messages.map((m) => `[${m.fromName || m.fromAddress}]:\n${m.bodyText}`).join('\n\n---\n\n')
          : props.messages[props.messages.length - 1].bodyText;
      const res = await apiRequest<{ translatedText: string }>('/productivity/ai/translate', {
        method: 'POST',
        signal,
        body: { text: sourceText, targetLanguage: targetLang },
      });
      setTranslatedText(res.translatedText);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Translation failed');
    } finally {
      setLoading(false);
    }
  }

  const consented = props.preferences.ai.enabled && props.preferences.ai.privacyDisclosureAccepted;
  const serverReady = Boolean(status?.provider.configured);

  return (
    <aside
      aria-label="AI Correspondence Assistant"
      className="no-print"
      style={{
        width: 340,
        minWidth: 320,
        height: '100%',
        background: 'var(--bg-elevated)',
        borderLeft: '1px solid var(--border-hairline)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--border-hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} color="var(--accent)" />
          <strong style={{ fontSize: 13.5 }}>Intelligence Panel</strong>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={props.onClose} aria-label="Close AI assistant">
          <X size={15} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--bg-subtle)' }}>
        {[
          { id: 'intel' as const, label: 'Thread Intel' },
          { id: 'search' as const, label: 'AI Search' },
          { id: 'agent' as const, label: 'Agent Workflows' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn btn-sm ${panelTab === t.id ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1, height: 26, fontSize: 11.5 }}
            onClick={() => setPanelTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Privacy Disclosure & Opt-In Gate */}
        {!consented && (
          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-hairline)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <strong style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Lock size={14} color="var(--accent)" /> AI Privacy & Consent
            </strong>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              AI features are strictly optional. When you trigger Summarize, Smart Replies, or Translate, only the selected conversation text (with sensitive patterns redacted when enabled) is sent through your server to the configured AI provider. Your OAuth tokens and passwords are never shared. Messages are never auto-sent.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={async () => {
                await props.onEnableAiConsent();
                await loadStatus();
              }}
            >
              Enable AI Assistant
            </button>
          </div>
        )}

        {/* Honest Unconfigured Server Guide */}
        {consented && status && !serverReady && (
          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-warning-bg)',
              border: '1px solid color-mix(in srgb, var(--status-warning) 35%, transparent)',
              color: 'var(--text-primary)',
              fontSize: 12.5,
            }}
          >
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--status-warning)' }}>
              <ShieldAlert size={14} /> Server AI Key Required
            </strong>
            <p style={{ margin: '6px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
              The integration pipeline is active, but no server-side API key is currently set:
            </p>
            <ol style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
              {status.provider.setupInstructions.map((step, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{step}</li>
              ))}
            </ol>
          </div>
        )}

        {consented && serverReady && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
            <span>Provider: <strong>{status?.provider.activeProvider}</strong> ({status?.provider.model})</span>
            <span>Redaction: {props.preferences.ai.redactSensitiveContent ? 'On' : 'Off'}</span>
          </div>
        )}

        {panelTab === 'search' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!nlQuery.trim()) return;
                const signal = beginAbortableRequest();
                setLoading(true);
                setError('');
                try {
                  const res = await apiRequest<any>('/productivity/ai/search', {
                    method: 'POST',
                    signal,
                    body: { query: nlQuery.trim() },
                  });
                  setSearchResult(res);
                } catch (err: any) {
                  if (err?.name !== 'AbortError') setError(err instanceof ApiError ? err.message : 'Search failed');
                } finally {
                  setLoading(false);
                }
              }}
              style={{ display: 'flex', gap: 6 }}
            >
              <input
                className="field"
                placeholder="Ask e.g. 'emails needing a reply' or 'from Alice pdf'..."
                value={nlQuery}
                onChange={(e) => setNlQuery(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={loading}>
                <Search size={13} />
              </button>
            </form>
            {searchResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <strong>Search Synthesis</strong>
                    <span className="chip" style={{ height: 18, fontSize: 10 }}>
                      {searchResult.usedLlm ? 'AI' : 'FTS5 Index'}
                    </span>
                  </div>
                  <div>{searchResult.answer}</div>
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                    Query: <code>{searchResult.queryUsed}</code>
                  </div>
                </div>
                {searchResult.threads.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="btn btn-ghost"
                    style={{ justifyContent: 'flex-start', textAlign: 'left', flexDirection: 'column', alignItems: 'flex-start', height: 'auto', padding: 8, border: '1px solid var(--border-hairline)' }}
                    onClick={() => props.onOpenThread?.(t.id)}
                  >
                    <strong style={{ fontSize: 12.5 }}>{t.subject}</strong>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t.snippet}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : panelTab === 'agent' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              Bounded Agent plans reversible steps from the active thread and requires your explicit confirmation before creating tasks, calendar events, or reply drafts (never auto-sends mail).
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                setError('');
                setWorkflowBanner('');
                try {
                  const res = await apiRequest<{ run: AiWorkflowRun }>('/productivity/ai/workflow/plan', {
                    method: 'POST',
                    body: {
                      prompt: agentPrompt.trim() || `Run ${agentType} on conversation`,
                      workflowType: agentType,
                      threadId: props.thread?.id || null,
                    },
                  });
                  setActiveRun(res.run);
                  await loadStatus();
                } catch (err: any) {
                  setError(err instanceof ApiError ? err.message : 'Unable to plan workflow');
                } finally {
                  setLoading(false);
                }
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <select className="field" value={agentType} onChange={(e) => setAgentType(e.target.value as any)}>
                <option value="summarize_and_tasks">Extract Deadlines &amp; Create Tasks</option>
                <option value="extract_calendar_event">Prepare Calendar Event</option>
                <option value="prepare_reply">Prepare Unsent Reply Draft</option>
              </select>
              <textarea
                className="field"
                rows={2}
                placeholder="Instructions for bounded agent..."
                value={agentPrompt}
                onChange={(e) => setAgentPrompt(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={loading}>
                <Sparkles size={13} /> Preview Workflow Plan
              </button>
            </form>

            {workflowBanner && (
              <div style={{ padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--status-success-bg)', color: 'var(--status-success)', fontSize: 12 }}>
                {workflowBanner}
              </div>
            )}

            {activeRun && activeRun.status === 'awaiting_confirmation' && (
              <div style={{ padding: 12, borderRadius: 'var(--radius-md)', border: '1px solid var(--accent)', background: 'var(--bg-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <strong style={{ fontSize: 12.5 }}>Proposed Steps (Awaiting Confirmation)</strong>
                {activeRun.plan.map((st, idx) => (
                  <div key={idx} style={{ padding: 8, borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>{idx + 1}. {st.title}</div>
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{st.description}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      const res = await apiRequest<{ executed: any[] }>(`/productivity/ai/workflow/${activeRun.id}/execute`, { method: 'POST' });
                      setWorkflowBanner(`Confirmed & executed ${res.executed.length} step(s).`);
                      setActiveRun(null);
                      await loadStatus();
                    }}
                  >
                    Confirm &amp; Execute
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      await apiRequest(`/productivity/ai/workflow/${activeRun.id}/cancel`, { method: 'POST' });
                      setActiveRun(null);
                      await loadStatus();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {workflowHistory.length > 0 && (
              <div>
                <strong style={{ fontSize: 12, color: 'var(--text-muted)' }}>Recent Workflow Runs ({workflowHistory.length})</strong>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {workflowHistory.slice(0, 6).map((r) => (
                    <div key={r.id} style={{ padding: 8, borderRadius: 'var(--radius-sm)', background: 'var(--bg-subtle)', fontSize: 11.5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong>{r.workflowType}</strong>
                        <span className="chip" style={{ height: 18, fontSize: 10 }}>{r.status}</span>
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{r.prompt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : !props.thread ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
            Select a conversation to summarize threads, extract action items, generate replies, or translate messages.
          </div>
        ) : (
          <>
            {/* Action Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={!consented || !serverReady || loading}
                onClick={() => void runAnalyze()}
              >
                <Sparkles size={14} /> Summarize Thread & Extract Tasks
              </button>

              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  aria-label="Reply tone"
                  className="field"
                  style={{ height: 34, fontSize: 12.5 }}
                  value={replyTone}
                  onChange={(e) => setReplyTone(e.target.value as any)}
                >
                  {['professional', 'formal', 'friendly', 'neutral', 'polite', 'confident', 'concise'].map((t) => (
                    <option key={t} value={t}>Tone: {t}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={!consented || !serverReady || loading}
                  onClick={() => void runSmartReplies()}
                >
                  <RefreshCw size={13} /> Smart Replies
                </button>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  aria-label="Target language"
                  className="field"
                  style={{ height: 34, fontSize: 12.5, flex: 1 }}
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                >
                  {['English', 'Spanish', 'French', 'German', 'Japanese', 'Hindi', 'Portuguese', 'Chinese'].map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
                <select
                  aria-label="Translation scope"
                  className="field"
                  style={{ height: 34, fontSize: 12, width: 105 }}
                  value={translateScope}
                  onChange={(e) => setTranslateScope(e.target.value as 'latest' | 'thread')}
                >
                  <option value="latest">Latest msg</option>
                  <option value="thread">Full thread</option>
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={!consented || !serverReady || loading}
                  onClick={() => void runTranslate()}
                >
                  <Languages size={14} /> Translate
                </button>
              </div>
              {loading && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    abortRef.current?.abort();
                    setLoading(false);
                  }}
                >
                  Cancel AI Request
                </button>
              )}
            </div>

            {error && (
              <div style={{ padding: 10, borderRadius: 'var(--radius-md)', background: 'var(--status-danger-bg)', color: 'var(--status-danger)', fontSize: 12.5 }}>
                {error}
              </div>
            )}

            {/* Thread Analysis & Action Items */}
            {analysis && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 13 }}>Thread Summary</strong>
                  <span className="chip" style={{ height: 19, fontSize: 10.5, color: 'var(--accent)' }}>AI-generated</span>
                </div>
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>{analysis.summary}</p>
                {analysis.keyPoints.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Key Points</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                      {analysis.keyPoints.map((pt, i) => <li key={i}>{pt}</li>)}
                    </ul>
                  </div>
                )}
                {analysis.unansweredQuestions && analysis.unansweredQuestions.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--status-warning)', marginBottom: 4 }}>Unanswered Questions</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                      {analysis.unansweredQuestions.map((q, i) => <li key={i}>{q}</li>)}
                    </ul>
                  </div>
                )}
                {analysis.decisions.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Decisions</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                      {analysis.decisions.map((d, i) => <li key={i}>{d}</li>)}
                    </ul>
                  </div>
                )}
                {analysis.tasks.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                      Detected Action Items (requires confirmation)
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {analysis.tasks.map((task, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: 8,
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-hairline)',
                            fontSize: 12,
                          }}
                        >
                          <div style={{ fontWeight: 600 }}>{task.title}</div>
                          {task.context && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{task.context}</div>}
                          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                              {task.suggestedDueAt ? `Due: ${task.suggestedDueAt}` : 'No fixed deadline'}
                            </span>
                            {savedTasks.has(idx) ? (
                              <span style={{ fontSize: 11, color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <CheckCircle2 size={12} /> Added
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ height: 24, fontSize: 11 }}
                                onClick={async () => {
                                  const due = task.suggestedDueAt && !Number.isNaN(new Date(task.suggestedDueAt).getTime())
                                    ? new Date(task.suggestedDueAt).toISOString()
                                    : new Date(Date.now() + 86_400_000).toISOString();
                                  const latestMsg = props.messages[props.messages.length - 1];
                                  if (props.thread && latestMsg) {
                                    await props.onCreateReminder(props.thread.id, latestMsg.id, task.title, due);
                                    setSavedTasks((prev) => new Set(prev).add(idx));
                                  }
                                }}
                              >
                                <BellPlus size={11} /> Save Reminder
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Smart Replies */}
            {replies.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 13 }}>Suggested Replies</strong>
                  <span className="chip" style={{ height: 19, fontSize: 10.5, color: 'var(--accent)' }}>AI-generated — verify before sending</span>
                </div>
                {replies.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 10,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-subtle)',
                      border: '1px solid var(--border-hairline)',
                      fontSize: 12.5,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.label}</div>
                    <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>{r.body}</p>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ marginTop: 8, height: 26, fontSize: 11.5 }}
                      onClick={() => props.onInsertReply(r.body)}
                    >
                      Insert into Composer
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Translation */}
            {translatedText && (
              <div style={{ padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5 }}>
                <strong style={{ fontSize: 12.5 }}>Translation ({targetLang})</strong>
                <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{translatedText}</p>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
