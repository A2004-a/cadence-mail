import { config } from '../config.js';

export type AiTone = 'professional' | 'formal' | 'friendly' | 'neutral' | 'polite' | 'confident' | 'concise';

export interface AiProviderStatus {
  configured: boolean;
  activeProvider: 'gemini' | 'openai' | 'anthropic' | null;
  model: string | null;
  setupInstructions: string[];
}

export function getAiProviderStatus(): AiProviderStatus {
  if (config.ai.geminiApiKey) {
    return {
      configured: true,
      activeProvider: 'gemini',
      model: config.ai.geminiModel,
      setupInstructions: [],
    };
  }
  if (config.ai.openaiApiKey) {
    return {
      configured: true,
      activeProvider: 'openai',
      model: config.ai.openaiModel,
      setupInstructions: [],
    };
  }
  if (config.ai.anthropicApiKey) {
    return {
      configured: true,
      activeProvider: 'anthropic',
      model: config.ai.anthropicModel,
      setupInstructions: [],
    };
  }
  return {
    configured: false,
    activeProvider: null,
    model: null,
    setupInstructions: [
      'Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY in the server .env file (never expose keys to the browser).',
      'Restart the Cadence server to activate server-side AI orchestration.',
      'Enable AI Features and accept the AI Privacy Disclosure in Settings -> AI & Privacy.',
    ],
  };
}

export function redactSensitivePatterns(text: string): string {
  return text
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED_CARD]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
    .replace(/(?:sk-[a-zA-Z0-9]{16,}|AIza[0-9A-Za-z-_]{25,}|ghp_[0-9A-Za-z]{20,})/g, '[REDACTED_TOKEN]')
    .replace(/(?:password|passcode|otp|pin)\s*[:=]\s*\S+/gi, '[REDACTED_SECRET]');
}

async function callLlm(systemPrompt: string, userPrompt: string, jsonMode = false, signal?: AbortSignal): Promise<string> {
  const status = getAiProviderStatus();
  if (!status.configured || !status.activeProvider) {
    throw new Error('AI_UNCONFIGURED');
  }

  if (status.activeProvider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      config.ai.geminiModel
    )}:generateContent?key=${encodeURIComponent(config.ai.geminiApiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: jsonMode ? { responseMimeType: 'application/json' } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (status.activeProvider === 'openai') {
    const res = await fetch(`${config.ai.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.ai.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ai.openaiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: jsonMode ? { type: 'json_object' } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || '';
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': config.ai.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ai.anthropicModel,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
  };
  return data.content?.[0]?.text || '';
}

export async function runAiTransform(params: {
  action: 'generate' | 'rewrite' | 'grammar' | 'clarity' | 'shorten' | 'expand' | 'summarize' | 'tone';
  instructions?: string;
  content: string;
  tone: AiTone;
  redactSensitive: boolean;
  signal?: AbortSignal;
}): Promise<{ text: string; provider: string; model: string }> {
  const safeContent = params.redactSensitive ? redactSensitivePatterns(params.content) : params.content;
  const safeInstructions = params.redactSensitive && params.instructions
    ? redactSensitivePatterns(params.instructions)
    : params.instructions || '';

  const systemPrompt =
    'You are Cadence Mail Assistant. Output clean, ready-to-send email body prose without markdown code fences or meta commentary. Never fabricate facts.';

  const userPrompt = [
    `Task: ${params.action}`,
    `Requested tone: ${params.tone}`,
    safeInstructions ? `User instructions: ${safeInstructions}` : '',
    safeContent ? `Existing email text:\n${safeContent}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const status = getAiProviderStatus();
  const output = await callLlm(systemPrompt, userPrompt, false, params.signal);
  return {
    text: output.trim(),
    provider: status.activeProvider || 'unknown',
    model: status.model || 'unknown',
  };
}

export async function runAiSmartReplies(params: {
  threadTranscript: string;
  tone: AiTone;
  redactSensitive: boolean;
  signal?: AbortSignal;
}): Promise<{ replies: Array<{ label: string; body: string }> }> {
  const safeTranscript = params.redactSensitive
    ? redactSensitivePatterns(params.threadTranscript)
    : params.threadTranscript;

  const raw = await callLlm(
    'Return valid JSON: {"replies": [{"label": "Short title", "body": "Reply text"}]} with exactly 3 distinct, concise contextual reply options.',
    `Tone: ${params.tone}\n\nConversation:\n${safeTranscript}`,
    true,
    params.signal
  );
  const parsed = JSON.parse(raw) as { replies?: Array<{ label: string; body: string }> };
  return { replies: (parsed.replies || []).slice(0, 3) };
}

export async function runAiThreadAnalysis(params: {
  threadTranscript: string;
  redactSensitive: boolean;
  signal?: AbortSignal;
}): Promise<{
  summary: string;
  keyPoints: string[];
  decisions: string[];
  requests: string[];
  unansweredQuestions: string[];
  deadlines: string[];
  tasks: Array<{ title: string; suggestedDueAt: string | null; context: string }>;
}> {
  const safeTranscript = params.redactSensitive
    ? redactSensitivePatterns(params.threadTranscript)
    : params.threadTranscript;

  const raw = await callLlm(
    `Analyze this email thread and return strict JSON with shape:
{
  "summary": "2-3 sentence overview",
  "keyPoints": ["..."],
  "decisions": ["..."],
  "requests": ["..."],
  "unansweredQuestions": ["open questions not yet answered"],
  "deadlines": ["..."],
  "tasks": [{"title": "action item", "suggestedDueAt": "ISO date or null", "context": "brief quote/source"}]
}`,
    safeTranscript,
    true,
    params.signal
  );
  const parsed = JSON.parse(raw) as {
    summary?: string;
    keyPoints?: string[];
    decisions?: string[];
    requests?: string[];
    unansweredQuestions?: string[];
    deadlines?: string[];
    tasks?: Array<{ title: string; suggestedDueAt: string | null; context: string }>;
  };
  return {
    summary: parsed.summary || '',
    keyPoints: parsed.keyPoints || [],
    decisions: parsed.decisions || [],
    requests: parsed.requests || [],
    unansweredQuestions: parsed.unansweredQuestions || [],
    deadlines: parsed.deadlines || [],
    tasks: parsed.tasks || [],
  };
}

export async function runAiTranslate(params: {
  text: string;
  targetLanguage: string;
  redactSensitive: boolean;
  signal?: AbortSignal;
}): Promise<{ translatedText: string }> {
  const safeText = params.redactSensitive ? redactSensitivePatterns(params.text) : params.text;
  const out = await callLlm(
    `Translate the provided email text accurately into ${params.targetLanguage}. Preserve paragraph breaks and tone. Return only the translation.`,
    safeText,
    false,
    params.signal
  );
  return { translatedText: out.trim() };
}

export function deriveSearchQueryFromNaturalLanguage(prompt: string): string {
  const lower = prompt.toLowerCase();
  const ops: string[] = [];
  if (/(unread|need(s)? (a )?repl|need(s)? response|unanswered)/i.test(lower)) ops.push('is:unread');
  if (/(starred|favorite)/i.test(lower)) ops.push('is:starred');
  if (/(important|urgent|asap|priority)/i.test(lower)) ops.push('is:important');
  if (/(attachment|attached|document|file|pdf|csv|invoice|receipt)/i.test(lower)) {
    if (/\bpdf\b/i.test(lower)) ops.push('filename:pdf');
    else if (/\bcsv\b/i.test(lower)) ops.push('filename:csv');
    else ops.push('has:attachment');
  }
  const fromMatch = prompt.match(/\bfrom\s+([a-z0-9._@-]+)/i);
  if (fromMatch && !['the', 'a', 'an', 'my'].includes(fromMatch[1].toLowerCase())) {
    ops.push(`from:${fromMatch[1]}`);
  }
  const stopWords = new Set([
    'find', 'show', 'search', 'emails', 'email', 'messages', 'message', 'mail', 'where', 'with',
    'that', 'need', 'needs', 'reply', 'replies', 'response', 'about', 'from', 'the', 'a', 'an',
    'related', 'to', 'me', 'my', 'recent', 'latest', 'containing', 'discussed', 'all', 'or', 'and',
    'document', 'documents', 'attachment', 'attachments', 'unread', 'important',
  ]);
  const words = prompt
    .replace(/[^a-zA-Z0-9._@-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w.toLowerCase()) && (!fromMatch || w.toLowerCase() !== fromMatch[1].toLowerCase()));
  return [...ops, ...words.slice(0, 4)].join(' ').trim();
}

export async function synthesizeAiSearchAnswer(params: {
  prompt: string;
  snippets: Array<{ threadId: string; subject: string; from: string; receivedAt: string; snippet: string }>;
  redactSensitive: boolean;
  signal?: AbortSignal;
}): Promise<{ answer: string; usedLlm: boolean }> {
  const status = getAiProviderStatus();
  if (!status.configured) {
    return {
      answer:
        params.snippets.length > 0
          ? `Found ${params.snippets.length} permitted conversation(s) matching your query across local search index.`
          : 'No matching conversations found across your permitted accounts.',
      usedLlm: false,
    };
  }
  const contextText = params.snippets
    .slice(0, 8)
    .map((s, i) => `[#${i + 1}] Subject: ${s.subject} | From: ${s.from} | Date: ${s.receivedAt}\n${s.snippet}`)
    .join('\n\n');
  const safeContext = params.redactSensitive ? redactSensitivePatterns(contextText) : contextText;
  const answer = await callLlm(
    'Answer the user search question strictly using ONLY the provided permitted email excerpts. Reference matching [#n] items concisely. Do not fabricate anything.',
    `Question: ${params.prompt}\n\nPermitted Excerpts:\n${safeContext || 'No matching emails.'}`,
    false,
    params.signal
  );
  return { answer: answer.trim(), usedLlm: true };
}

export interface PlannedWorkflowStep {
  stepType: 'create_task' | 'create_reminder' | 'create_event' | 'create_draft' | 'organize_thread';
  title: string;
  description: string;
  reversible: boolean;
  payload: Record<string, any>;
}

export async function planAiWorkflowSteps(params: {
  prompt: string;
  workflowType: string;
  thread?: { id: string; subject: string; accountId: string } | null;
  messages: Array<{ id: string; fromName: string; fromAddress: string; subject: string; bodyText: string }>;
  redactSensitive: boolean;
  allowLlm: boolean;
  signal?: AbortSignal;
}): Promise<{ steps: PlannedWorkflowStep[]; usedLlm: boolean }> {
  const latest = params.messages[params.messages.length - 1];
  const transcript = params.messages
    .map((m) => `From: ${m.fromName || m.fromAddress}\nSubject: ${m.subject}\n${m.bodyText}`)
    .join('\n---\n');
  const status = getAiProviderStatus();

  if (params.allowLlm && status.configured && transcript) {
    const safeTranscript = params.redactSensitive ? redactSensitivePatterns(transcript) : transcript;
    try {
      const raw = await callLlm(
        `Plan bounded productivity workflow steps for the user's request WITHOUT auto-sending email or deleting data.
Return strict JSON:
{
  "steps": [
    {
      "stepType": "create_task" | "create_reminder" | "create_event" | "create_draft" | "organize_thread",
      "title": "Short step summary",
      "description": "What this step will create or update",
      "reversible": true,
      "payload": { ... }
    }
  ]
}
For create_task: payload={title, priority:"medium"|"high", dueAt: ISO|null}.
For create_reminder: payload={title, dueAt: ISO}.
For create_event: payload={title, startAt: ISO, endAt: ISO, location:""}.
For create_draft: payload={bodyText, mode:"reply"}.
For organize_thread: payload={action:"star"|"archive"|"mark_read"}.`,
        `Workflow request (${params.workflowType}): ${params.prompt}\n\nThread Context:\n${safeTranscript.slice(0, 14_000)}`,
        true,
        params.signal
      );
      const parsed = JSON.parse(raw) as { steps?: PlannedWorkflowStep[] };
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        return { steps: parsed.steps.slice(0, 5), usedLlm: true };
      }
    } catch {
      // Fallback to bounded deterministic planner below
    }
  }

  // Deterministic bounded step preview builder (safe, zero fabrication)
  const steps: PlannedWorkflowStep[] = [];
  const subj = params.thread?.subject || latest?.subject || 'Conversation follow-up';
  const cleanSubj = subj.replace(/^(?:re|fwd|fw):\s*/i, '').trim() || 'Follow-up';
  const tmrw = new Date(Date.now() + 86_400_000);
  tmrw.setHours(10, 0, 0, 0);
  const tmrwEnd = new Date(tmrw.getTime() + 3600_000);

  if (params.workflowType === 'extract_calendar_event' || /meeting|calendar|schedule|event/i.test(params.prompt)) {
    steps.push({
      stepType: 'create_event',
      title: `Schedule "${cleanSubj}"`,
      description: `Create a calendar event for tomorrow at ${tmrw.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} linked to this thread.`,
      reversible: true,
      payload: {
        title: cleanSubj,
        startAt: tmrw.toISOString(),
        endAt: tmrwEnd.toISOString(),
        location: '',
        description: `Planned from email thread: ${subj}`,
      },
    });
  }
  if (params.workflowType === 'prepare_reply' || /reply|draft|respond/i.test(params.prompt)) {
    if (latest) {
      steps.push({
        stepType: 'create_draft',
        title: `Prepare reply draft to ${latest.fromName || latest.fromAddress}`,
        description: 'Creates an editable unsent reply draft for your review (never sent automatically).',
        reversible: true,
        payload: {
          mode: 'reply',
          bodyText: `Hi ${latest.fromName || 'there'},\n\nThank you for your note regarding "${cleanSubj}". Reviewing this now and will confirm details shortly.\n`,
        },
      });
    }
  }
  if (params.workflowType === 'summarize_and_tasks' || steps.length === 0 || /task|todo|deadline|follow/i.test(params.prompt)) {
    steps.push({
      stepType: 'create_task',
      title: `Create task: ${cleanSubj}`,
      description: 'Saves a linked action task due in 24 hours.',
      reversible: true,
      payload: {
        title: `Follow up: ${cleanSubj}`,
        priority: /urgent|asap|deadline/i.test(transcript) ? 'high' : 'medium',
        dueAt: tmrw.toISOString(),
      },
    });
    steps.push({
      stepType: 'create_reminder',
      title: `Set 24h follow-up reminder`,
      description: 'Adds a pending follow-up reminder linked to the conversation.',
      reversible: true,
      payload: {
        title: `Reminder: ${cleanSubj}`,
        dueAt: tmrw.toISOString(),
      },
    });
  }

  return { steps, usedLlm: false };
}
