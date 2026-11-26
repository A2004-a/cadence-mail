import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Clock,
  Download,
  Edit2,
  ExternalLink,
  Eye,
  FilePlus2,
  Filter,
  FolderOpen,
  MapPin,
  Paperclip,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { ApiError, apiRequest } from '../api/client';
import type {
  Account,
  AutomationAsset,
  AutomationInfoProfile,
  Category,
  Folder,
  Label,
  Rule,
  RuleAction,
  RuleCondition,
  RuleExecutionLog,
  ScheduledAutomation,
  ScheduledAutomationLog,
} from '../types';
import { formatBytes } from './CadenceMark';

interface RulesViewProps {
  accounts?: Account[];
  folders: Folder[];
  labels: Label[];
  categories: Category[];
  onRefreshMail: () => void;
  initialPrefill?: { fromAddress: string; subject: string } | null;
  onConsumePrefill?: () => void;
}

type AutomationTab = 'rules' | 'scheduled' | 'vault';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function readFileAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseRecipientCsv(csv: string): Array<{ name: string; address: string }> {
  return csv
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
    .map((address) => ({ name: '', address }));
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function RulesView({
  accounts = [],
  folders,
  labels,
  categories,
  onRefreshMail,
  initialPrefill,
  onConsumePrefill,
}: RulesViewProps) {
  const [tab, setTab] = useState<AutomationTab>('rules');
  const [statusBanner, setStatusBanner] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string>('');

  // Shared Vault & Scheduled state
  const [assets, setAssets] = useState<AutomationAsset[]>([]);
  const [infoProfiles, setInfoProfiles] = useState<AutomationInfoProfile[]>([]);
  const [scheduledList, setScheduledList] = useState<ScheduledAutomation[]>([]);
  const [scheduledLogs, setScheduledLogs] = useState<ScheduledAutomationLog[]>([]);
  const [fallbackAccounts, setFallbackAccounts] = useState<Account[]>(accounts);

  // Incoming Rules state
  const [rules, setRules] = useState<Rule[]>([]);
  const [execLogs, setExecLogs] = useState<RuleExecutionLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [stopProcessing, setStopProcessing] = useState(false);
  const [conditions, setConditions] = useState<RuleCondition[]>([{ field: 'from', operator: 'contains', value: '' }]);
  const [actions, setActions] = useState<RuleAction[]>([{ type: 'apply_label', value: labels[0]?.id || '' }]);
  const [previewMatches, setPreviewMatches] = useState<Array<{ id: string; subject: string; fromAddress: string }> | null>(null);
  const [previewCount, setPreviewCount] = useState<number>(0);

  // Scheduled Recurring Mail state
  const [schedCreating, setSchedCreating] = useState(false);
  const [editingSchedId, setEditingSchedId] = useState<string | null>(null);
  const [schedAccountId, setSchedAccountId] = useState(accounts[0]?.id || '');
  const [schedName, setSchedName] = useState('');
  const [schedFrequency, setSchedFrequency] = useState<ScheduledAutomation['frequency']>('daily');
  const [schedTime, setSchedTime] = useState('05:00');
  const [schedTz, setSchedTz] = useState(defaultTimezone);
  const [schedDays, setSchedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [schedDom, setSchedDom] = useState(1);
  const [schedIntervalHours, setSchedIntervalHours] = useState(24);
  const [schedToCsv, setSchedToCsv] = useState('');
  const [schedCcCsv, setSchedCcCsv] = useState('');
  const [schedSubject, setSchedSubject] = useState('Daily Check-in ({{date}})');
  const [schedBody, setSchedBody] = useState('Hi,\n\nSharing my daily update and attachment.');
  const [schedInfoIds, setSchedInfoIds] = useState<string[]>([]);
  const [schedAssetIds, setSchedAssetIds] = useState<string[]>([]);
  const [schedMaxRuns, setSchedMaxRuns] = useState<string>('');

  // Shared Info Vault form state
  const [infoCreating, setInfoCreating] = useState(false);
  const [editingInfoId, setEditingInfoId] = useState<string | null>(null);
  const [infoKind, setInfoKind] = useState<AutomationInfoProfile['kind']>('location');
  const [infoTitle, setInfoTitle] = useState('');
  const [infoSlug, setInfoSlug] = useState('');
  const [infoMapQuery, setInfoMapQuery] = useState('');
  const [infoMapUrl, setInfoMapUrl] = useState('');
  const [infoContentText, setInfoContentText] = useState('');
  const [infoAssetIds, setInfoAssetIds] = useState<string[]>([]);

  const activeAccounts = accounts.length > 0 ? accounts : fallbackAccounts;

  async function loadAllAutomations() {
    const [rulesRes, logsRes, assetsRes, infoRes, schedRes] = await Promise.all([
      apiRequest<{ rules: Rule[] }>('/org/rules'),
      apiRequest<{ logs: RuleExecutionLog[] }>('/org/rules/logs'),
      apiRequest<{ assets: AutomationAsset[] }>('/automations/assets'),
      apiRequest<{ profiles: AutomationInfoProfile[] }>('/automations/info'),
      apiRequest<{ automations: ScheduledAutomation[]; logs: ScheduledAutomationLog[] }>('/automations/scheduled'),
    ]);
    setRules(rulesRes.rules);
    setExecLogs(logsRes.logs || []);
    setAssets(assetsRes.assets || []);
    setInfoProfiles(infoRes.profiles || []);
    setScheduledList(schedRes.automations || []);
    setScheduledLogs(schedRes.logs || []);

    if (accounts.length === 0) {
      try {
        const acctRes = await apiRequest<{ accounts: Account[] }>('/accounts');
        setFallbackAccounts(acctRes.accounts || []);
        if (!schedAccountId && acctRes.accounts?.length > 0) {
          setSchedAccountId(acctRes.accounts[0].id);
        }
      } catch {
        // ignore
      }
    } else if (!schedAccountId && accounts[0]) {
      setSchedAccountId(accounts[0].id);
    }
  }

  useEffect(() => {
    void loadAllAutomations();
  }, []);

  useEffect(() => {
    if (!initialPrefill) return;
    setTab('rules');
    setEditingRuleId(null);
    setName(`Filter ${initialPrefill.fromAddress}`.slice(0, 60));
    setMatchMode('all');
    setConditions([{ field: 'from', operator: 'contains', value: initialPrefill.fromAddress }]);
    setActions([{ type: 'apply_label', value: labels[0]?.id || '' }]);
    setShowLogs(false);
    setCreating(true);
    onConsumePrefill?.();
  }, [initialPrefill, labels, onConsumePrefill]);

  async function uploadAssetFile(file: File): Promise<AutomationAsset | null> {
    setErrorBanner('');
    try {
      const contentBase64 = await readFileAsBase64(file);
      const res = await apiRequest<{ asset: AutomationAsset }>('/automations/assets', {
        method: 'POST',
        body: {
          name: file.name,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64,
        },
      });
      await loadAllAutomations();
      setStatusBanner(`Saved reusable automation attachment "${res.asset.filename}".`);
      return res.asset;
    } catch (err) {
      setErrorBanner(err instanceof ApiError ? err.message : 'Unable to upload attachment file.');
      return null;
    }
  }

  function resetRuleForm() {
    setEditingRuleId(null);
    setName('');
    setMatchMode('all');
    setStopProcessing(false);
    setConditions([{ field: 'from', operator: 'contains', value: '' }]);
    setActions([{ type: 'apply_label', value: labels[0]?.id || '' }]);
    setPreviewMatches(null);
  }

  function startEditRule(r: Rule) {
    setTab('rules');
    setEditingRuleId(r.id);
    setName(r.name);
    setMatchMode(r.matchMode);
    setStopProcessing(r.stopProcessing);
    setConditions(r.conditions.length > 0 ? r.conditions : [{ field: 'from', operator: 'contains', value: '' }]);
    setActions(r.actions.length > 0 ? r.actions : [{ type: 'mark_read' }]);
    setPreviewMatches(null);
    setCreating(true);
  }

  function applyRuleBlueprint(kind: 'location' | 'sender_pack' | 'forward_att' | 'task_vip') {
    setTab('rules');
    setShowLogs(false);
    setEditingRuleId(null);
    setPreviewMatches(null);
    const locProfile = infoProfiles.find((p) => p.kind === 'location');
    if (kind === 'location') {
      setName('Auto-Share Google Maps Location on Ask');
      setMatchMode('any');
      setConditions([
        { field: 'keywords', operator: 'contains_any', value: 'location, google map, map, address, directions, where are you' },
      ]);
      setActions([
        {
          type: 'auto_reply',
          value: 'Hi {{from_name}},\n\nHere is my Google Maps location & directions:\n{{google_map_location}}\n\nBest regards,\n{{my_name}}',
          infoProfileIds: locProfile ? [locProfile.id] : [],
          attachmentIds: [],
        },
      ]);
    } else if (kind === 'sender_pack') {
      setName('Share Attached Info for Specific Sender');
      setMatchMode('all');
      setConditions([{ field: 'from', operator: 'contains', value: 'client@example.com' }]);
      setActions([
        {
          type: 'auto_reply',
          value: 'Hi {{from_name}},\n\nThanks for reaching out. Attached is the requested information package.\n{{google_map_location}}',
          infoProfileIds: locProfile ? [locProfile.id] : [],
          attachmentIds: assets[0] ? [assets[0].id] : [],
        },
      ]);
    } else if (kind === 'forward_att') {
      setName('Forward Mail + Attachments Automatically');
      setMatchMode('all');
      setConditions([{ field: 'from', operator: 'contains', value: 'vendor@example.com' }]);
      setActions([{ type: 'forward', value: 'team@yourdomain.com', includeOriginalAttachments: true, attachmentIds: [] }]);
    } else {
      setName('Escalate Urgent Keywords to Task + Notification');
      setMatchMode('any');
      setConditions([{ field: 'keywords', operator: 'contains_any', value: 'urgent, deadline, action required, asap' }]);
      setActions([{ type: 'mark_important' }, { type: 'create_task' }, { type: 'notify' }]);
    }
    setCreating(true);
  }

  async function handleReorder(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setRules(next);
    await apiRequest('/org/rules/reorder', {
      method: 'POST',
      body: { ruleIds: next.map((r) => r.id) },
    });
    await loadAllAutomations();
  }

  async function handlePreview() {
    const res = await apiRequest<{ matchCount: number; matches: Array<{ id: string; subject: string; fromAddress: string }> }>(
      '/org/rules/preview',
      { method: 'POST', body: { matchMode, conditions } }
    );
    setPreviewCount(res.matchCount);
    setPreviewMatches(res.matches);
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setErrorBanner('');
    try {
      if (editingRuleId) {
        await apiRequest(`/org/rules/${editingRuleId}`, {
          method: 'PATCH',
          body: { name: name.trim(), matchMode, conditions, actions, stopProcessing },
        });
        setStatusBanner(`Updated rule "${name.trim()}".`);
      } else {
        await apiRequest('/org/rules', {
          method: 'POST',
          body: { name: name.trim(), matchMode, conditions, actions, stopProcessing, enabled: true },
        });
        setStatusBanner(`Activated rule "${name.trim()}".`);
      }
      setCreating(false);
      resetRuleForm();
      await loadAllAutomations();
    } catch (err) {
      setErrorBanner(err instanceof ApiError ? err.message : 'Unable to save rule.');
    }
  }

  function resetScheduledForm() {
    setEditingSchedId(null);
    setSchedAccountId(activeAccounts[0]?.id || '');
    setSchedName('');
    setSchedFrequency('daily');
    setSchedTime('05:00');
    setSchedTz(defaultTimezone());
    setSchedDays([1, 2, 3, 4, 5]);
    setSchedDom(1);
    setSchedIntervalHours(24);
    setSchedToCsv('');
    setSchedCcCsv('');
    setSchedSubject('Daily Check-in ({{date}})');
    setSchedBody('Hi,\n\nSending my daily check-in and attached information.');
    setSchedInfoIds([]);
    setSchedAssetIds([]);
    setSchedMaxRuns('');
  }

  function applyDaily5amBlueprint() {
    setTab('scheduled');
    resetScheduledForm();
    setSchedName('Daily 5:00 AM Check-in + Attachment');
    setSchedFrequency('daily');
    setSchedTime('05:00');
    setSchedSubject('Hi — Daily Update ({{date}})');
    setSchedBody('Hi,\n\nGood morning! Please find today’s attached update for {{day}}, {{date}}.\n{{google_map_location}}');
    if (assets[0]) setSchedAssetIds([assets[0].id]);
    const loc = infoProfiles.find((p) => p.kind === 'location');
    if (loc) setSchedInfoIds([loc.id]);
    setSchedCreating(true);
  }

  function startEditScheduled(s: ScheduledAutomation) {
    setTab('scheduled');
    setEditingSchedId(s.id);
    setSchedAccountId(s.accountId);
    setSchedName(s.name);
    setSchedFrequency(s.frequency);
    setSchedTime(s.timeOfDay);
    setSchedTz(s.timezone);
    setSchedDays(s.daysOfWeek || [1, 2, 3, 4, 5]);
    setSchedDom(s.dayOfMonth || 1);
    setSchedIntervalHours(s.intervalHours || 24);
    setSchedToCsv(s.to.map((p) => p.address).join(', '));
    setSchedCcCsv(s.cc.map((p) => p.address).join(', '));
    setSchedSubject(s.subject);
    setSchedBody(s.bodyText);
    setSchedInfoIds(s.infoProfileIds || []);
    setSchedAssetIds(s.attachmentIds || []);
    setSchedMaxRuns(s.maxRuns ? String(s.maxRuns) : '');
    setSchedCreating(true);
  }

  async function handleSaveScheduled(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner('');
    const to = parseRecipientCsv(schedToCsv);
    const cc = parseRecipientCsv(schedCcCsv);
    if (!schedAccountId) {
      setErrorBanner('Connect or select a sending mailbox first.');
      return;
    }
    if (to.length === 0) {
      setErrorBanner('Enter at least one valid To email address.');
      return;
    }
    const payload = {
      accountId: schedAccountId,
      name: schedName.trim(),
      frequency: schedFrequency,
      timeOfDay: schedTime,
      timezone: schedTz.trim() || 'UTC',
      daysOfWeek: schedDays,
      dayOfMonth: schedDom,
      intervalHours: schedIntervalHours,
      to,
      cc,
      subject: schedSubject.trim(),
      bodyText: schedBody,
      infoProfileIds: schedInfoIds,
      attachmentIds: schedAssetIds,
      maxRuns: schedMaxRuns.trim() ? Number(schedMaxRuns.trim()) : null,
      enabled: true,
    };
    try {
      if (editingSchedId) {
        await apiRequest(`/automations/scheduled/${editingSchedId}`, { method: 'PATCH', body: payload });
        setStatusBanner(`Updated scheduled automation "${schedName.trim()}".`);
      } else {
        await apiRequest('/automations/scheduled', { method: 'POST', body: payload });
        setStatusBanner(`Scheduled automation "${schedName.trim()}" activated.`);
      }
      setSchedCreating(false);
      resetScheduledForm();
      await loadAllAutomations();
    } catch (err) {
      setErrorBanner(err instanceof ApiError ? err.message : 'Unable to save scheduled automation.');
    }
  }

  function resetInfoForm(defaultKind: AutomationInfoProfile['kind'] = 'location') {
    setEditingInfoId(null);
    setInfoKind(defaultKind);
    setInfoTitle(defaultKind === 'location' ? 'My Google Maps Location' : '');
    setInfoSlug(defaultKind === 'location' ? 'location' : '');
    setInfoMapQuery('');
    setInfoMapUrl('');
    setInfoContentText('');
    setInfoAssetIds([]);
  }

  function startEditInfo(p: AutomationInfoProfile) {
    setTab('vault');
    setEditingInfoId(p.id);
    setInfoKind(p.kind);
    setInfoTitle(p.title);
    setInfoSlug(p.slug);
    setInfoMapQuery(p.mapQuery);
    setInfoMapUrl(p.mapUrl);
    setInfoContentText(p.contentText);
    setInfoAssetIds(p.attachmentIds || []);
    setInfoCreating(true);
  }

  async function handleSaveInfoProfile(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner('');
    const payload = {
      kind: infoKind,
      title: infoTitle.trim(),
      ...(infoSlug.trim() ? { slug: infoSlug.trim() } : {}),
      mapQuery: infoMapQuery.trim(),
      mapUrl: infoMapUrl.trim(),
      contentText: infoContentText,
      attachmentIds: infoAssetIds,
    };
    try {
      if (editingInfoId) {
        await apiRequest(`/automations/info/${editingInfoId}`, { method: 'PATCH', body: payload });
        setStatusBanner(`Updated shared info "${infoTitle.trim()}".`);
      } else {
        await apiRequest('/automations/info', { method: 'POST', body: payload });
        setStatusBanner(`Saved shared info "${infoTitle.trim()}" to Vault.`);
      }
      setInfoCreating(false);
      resetInfoForm();
      await loadAllAutomations();
    } catch (err) {
      setErrorBanner(err instanceof ApiError ? err.message : 'Unable to save shared info profile.');
    }
  }

  const booleanFields = new Set(['has_attachment', 'is_read', 'is_starred', 'is_important']);
  const replyActionTypes = new Set(['auto_reply', 'generate_draft', 'forward']);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
      <div style={{ maxWidth: 940, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Automations &amp; Rules</h1>
            <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
              Schedule recurring attached emails (like daily 5:00 AM check-ins), auto-share Google Maps locations or files on keyword/sender triggers, and manage reusable info packs.
            </p>
          </div>
          {tab === 'rules' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setShowLogs((v) => !v)}>
                {showLogs ? 'Show Rules' : `Execution Logs (${execLogs.length})`}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (creating) {
                    setCreating(false);
                    resetRuleForm();
                  } else {
                    resetRuleForm();
                    setCreating(true);
                  }
                }}
              >
                <Plus size={15} /> {creating ? 'Close Editor' : 'Create Rule'}
              </button>
            </div>
          )}
          {tab === 'scheduled' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (schedCreating) {
                  setSchedCreating(false);
                  resetScheduledForm();
                } else {
                  resetScheduledForm();
                  setSchedCreating(true);
                }
              }}
            >
              <Plus size={15} /> {schedCreating ? 'Close Schedule Editor' : 'New Scheduled Email'}
            </button>
          )}
          {tab === 'vault' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (infoCreating) {
                  setInfoCreating(false);
                  resetInfoForm();
                } else {
                  resetInfoForm('location');
                  setInfoCreating(true);
                }
              }}
            >
              <Plus size={15} /> {infoCreating ? 'Close Info Editor' : 'Add Info / Location Card'}
            </button>
          )}
        </div>

        {/* Sub-navigation Tabs */}
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            borderBottom: '1px solid var(--border-hairline)',
            paddingBottom: 10,
          }}
        >
          <button
            type="button"
            className={`btn btn-sm ${tab === 'rules' ? 'btn-primary' : ''}`}
            onClick={() => setTab('rules')}
          >
            <Filter size={13} /> Incoming Rules ({rules.length})
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === 'scheduled' ? 'btn-primary' : ''}`}
            onClick={() => setTab('scheduled')}
          >
            <CalendarClock size={13} /> Scheduled &amp; Recurring Mail ({scheduledList.length})
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === 'vault' ? 'btn-primary' : ''}`}
            onClick={() => setTab('vault')}
          >
            <MapPin size={13} /> Shared Info &amp; Files Vault ({infoProfiles.length} info · {assets.length} files)
          </button>
        </div>

        {statusBanner && (
          <div
            role="status"
            style={{
              padding: '9px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-success-bg)',
              color: 'var(--status-success)',
              fontSize: 12.5,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{statusBanner}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStatusBanner('')}>
              Dismiss
            </button>
          </div>
        )}

        {errorBanner && (
          <div
            role="alert"
            style={{
              padding: '9px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-danger-bg)',
              color: 'var(--status-danger)',
              fontSize: 12.5,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{errorBanner}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setErrorBanner('')}>
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: INCOMING MAIL RULES */}
        {tab === 'rules' && (
          <>
            {/* Quick Automation Blueprints */}
            {!creating && !showLogs && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-hairline)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                  <Sparkles size={13} color="var(--accent)" /> One-Click Automation Blueprints
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-sm" onClick={() => applyRuleBlueprint('location')}>
                    <MapPin size={12} /> Share Google Maps Location on Ask
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => applyRuleBlueprint('sender_pack')}>
                    <Paperclip size={12} /> Share File + Info When Sender Emails
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => applyRuleBlueprint('forward_att')}>
                    Auto-Forward + Original Attachments
                  </button>
                  <button type="button" className="btn btn-sm" onClick={applyDaily5amBlueprint}>
                    <Clock size={12} /> Daily 5:00 AM Email + Attachment
                  </button>
                </div>
              </div>
            )}

            {creating && (
              <form
                onSubmit={handleSaveRule}
                style={{
                  padding: 18,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-elevated)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    className="field"
                    style={{ flex: 2 }}
                    placeholder="Rule name (e.g. 'Archive Receipts')"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                  <select className="field" style={{ flex: 1 }} value={matchMode} onChange={(e) => setMatchMode(e.target.value as 'all' | 'any')}>
                    <option value="all">Match ALL conditions</option>
                    <option value="any">Match ANY condition</option>
                  </select>
                </div>

                <div>
                  <strong style={{ fontSize: 12.5 }}>Conditions</strong>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                    {conditions.map((cond, idx) => (
                      <div key={idx} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <select
                          className="field"
                          style={{ width: 150 }}
                          value={cond.field}
                          onChange={(e) => {
                            const next = [...conditions];
                            next[idx] = { ...cond, field: e.target.value as any };
                            setConditions(next);
                          }}
                        >
                          <option value="from">From</option>
                          <option value="to">To</option>
                          <option value="subject">Subject</option>
                          <option value="body">Body</option>
                          <option value="keywords">Keywords (Subj+Body)</option>
                          <option value="domain">Sender Domain</option>
                          <option value="category">Category</option>
                          <option value="has_attachment">Has Attachment</option>
                          <option value="is_read">Is Read</option>
                          <option value="is_starred">Is Starred</option>
                          <option value="is_important">Is Important</option>
                          <option value="date_after">Date After</option>
                          <option value="date_before">Date Before</option>
                        </select>
                        <select
                          className="field"
                          style={{ width: 185 }}
                          value={cond.operator}
                          onChange={(e) => {
                            const next = [...conditions];
                            next[idx] = { ...cond, operator: e.target.value as any };
                            setConditions(next);
                          }}
                        >
                          <option value="contains">Contains</option>
                          <option value="contains_any">Contains any keyword (comma)</option>
                          <option value="regex">Regex match</option>
                          <option value="not_contains">Does not contain</option>
                          <option value="equals">Equals</option>
                          <option value="starts_with">Starts with</option>
                          <option value="ends_with">Ends with</option>
                          <option value="is_true">Is true</option>
                          <option value="is_false">Is false</option>
                        </select>
                        {!booleanFields.has(cond.field) && (
                          <input
                            className="field"
                            style={{ flex: 1, minWidth: 180 }}
                            placeholder={cond.operator === 'contains_any' ? 'location, map, address, directions...' : 'Value...'}
                            value={cond.value}
                            onChange={(e) => {
                              const next = [...conditions];
                              next[idx] = { ...cond, value: e.target.value };
                              setConditions(next);
                            }}
                          />
                        )}
                        {conditions.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            onClick={() => setConditions(conditions.filter((_, i) => i !== idx))}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => setConditions([...conditions, { field: 'subject', operator: 'contains', value: '' }])}
                    >
                      + Add condition
                    </button>
                  </div>
                </div>

                <div>
                  <strong style={{ fontSize: 12.5 }}>Actions</strong>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
                    {actions.map((act, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: replyActionTypes.has(act.type) ? 10 : 0,
                          borderRadius: 'var(--radius-md)',
                          background: replyActionTypes.has(act.type) ? 'var(--bg-subtle)' : 'transparent',
                          border: replyActionTypes.has(act.type) ? '1px solid var(--border-hairline)' : 'none',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <select
                            className="field"
                            style={{ width: 200 }}
                            value={act.type}
                            onChange={(e) => {
                              const next = [...actions];
                              next[idx] = { type: e.target.value as any, value: '' };
                              setActions(next);
                            }}
                          >
                            <option value="apply_label">Apply Label</option>
                            <option value="move_to_folder">Move to Folder</option>
                            <option value="categorize">Assign Category</option>
                            <option value="mark_read">Mark as Read</option>
                            <option value="mark_unread">Mark as Unread</option>
                            <option value="mark_important">Mark Important</option>
                            <option value="star">Star Message</option>
                            <option value="archive">Archive / Skip Inbox</option>
                            <option value="notify">Send Notification</option>
                            <option value="create_task">Create Task</option>
                            <option value="create_reminder">Create Reminder</option>
                            <option value="create_event">Create Calendar Event</option>
                            <option value="generate_draft">Generate Draft Reply (+ Info/Files)</option>
                            <option value="auto_reply">Send Safe Auto-Reply (+ Info/Files)</option>
                            <option value="forward">Forward Safely (+ Attachments)</option>
                          </select>

                          {(act.type === 'create_task' || act.type === 'create_reminder' || act.type === 'create_event') && (
                            <input
                              className="field"
                              style={{ flex: 1 }}
                              placeholder="Optional custom title..."
                              value={act.value || ''}
                              onChange={(e) => {
                                const next = [...actions];
                                next[idx] = { ...act, value: e.target.value };
                                setActions(next);
                              }}
                            />
                          )}

                          {act.type === 'forward' && (
                            <input
                              type="email"
                              className="field"
                              style={{ flex: 1 }}
                              placeholder="Forwarding recipient email..."
                              value={act.value || ''}
                              onChange={(e) => {
                                const next = [...actions];
                                next[idx] = { ...act, value: e.target.value };
                                setActions(next);
                              }}
                              required
                            />
                          )}

                          {act.type === 'apply_label' && (
                            <select
                              className="field"
                              style={{ flex: 1 }}
                              value={act.value || ''}
                              onChange={(e) => {
                                const next = [...actions];
                                next[idx] = { ...act, value: e.target.value };
                                setActions(next);
                              }}
                            >
                              <option value="">Select label...</option>
                              {labels.map((l) => (
                                <option key={l.id} value={l.id}>{l.name}</option>
                              ))}
                            </select>
                          )}
                          {act.type === 'move_to_folder' && (
                            <select
                              className="field"
                              style={{ flex: 1 }}
                              value={act.value || ''}
                              onChange={(e) => {
                                const next = [...actions];
                                next[idx] = { ...act, value: e.target.value };
                                setActions(next);
                              }}
                            >
                              <option value="">Select folder...</option>
                              {folders.map((f) => (
                                <option key={f.id} value={f.id}>{f.name}</option>
                              ))}
                            </select>
                          )}
                          {act.type === 'categorize' && (
                            <select
                              className="field"
                              style={{ flex: 1 }}
                              value={act.value || ''}
                              onChange={(e) => {
                                const next = [...actions];
                                next[idx] = { ...act, value: e.target.value };
                                setActions(next);
                              }}
                            >
                              <option value="">Select category...</option>
                              {categories.map((c) => (
                                <option key={c.slug} value={c.slug}>{c.name}</option>
                              ))}
                            </select>
                          )}

                          {actions.length > 1 && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon"
                              onClick={() => setActions(actions.filter((_, i) => i !== idx))}
                              title="Remove action"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>

                        {replyActionTypes.has(act.type) && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                            <input
                              className="field"
                              placeholder="Optional custom subject override (supports {{subject}}, {{from_name}}, {{date}})"
                              value={act.subject || ''}
                              onChange={(e) => {
                                const next = [...actions];
                                next[idx] = { ...act, subject: e.target.value };
                                setActions(next);
                              }}
                            />
                            {(act.type === 'auto_reply' || act.type === 'generate_draft') && (
                              <>
                                <textarea
                                  className="field"
                                  rows={3}
                                  placeholder="Reply template (supports {{from_name}}, {{google_map_location}}, {{contact_info}}, {{date}}, {{info:slug}})"
                                  value={act.value || ''}
                                  onChange={(e) => {
                                    const next = [...actions];
                                    next[idx] = { ...act, value: e.target.value };
                                    setActions(next);
                                  }}
                                />
                                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Insert token:</span>
                                  {['{{from_name}}', '{{google_map_location}}', '{{contact_info}}', '{{date}}'].map((tok) => (
                                    <button
                                      key={tok}
                                      type="button"
                                      className="chip"
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => {
                                        const next = [...actions];
                                        next[idx] = { ...act, value: `${act.value || ''}${act.value ? ' ' : ''}${tok}` };
                                        setActions(next);
                                      }}
                                    >
                                      {tok}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}

                            {act.type === 'forward' && (
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(act.includeOriginalAttachments)}
                                  onChange={(e) => {
                                    const next = [...actions];
                                    next[idx] = { ...act, includeOriginalAttachments: e.target.checked };
                                    setActions(next);
                                  }}
                                />
                                Include original email attachments when forwarding
                              </label>
                            )}

                            {infoProfiles.length > 0 && (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Append Shared Info:</span>
                                {infoProfiles.map((p) => {
                                  const selected = (act.infoProfileIds || []).includes(p.id);
                                  return (
                                    <button
                                      key={p.id}
                                      type="button"
                                      className={`btn btn-sm ${selected ? 'btn-primary' : ''}`}
                                      style={{ height: 23, fontSize: 11 }}
                                      onClick={() => {
                                        const cur = new Set(act.infoProfileIds || []);
                                        if (cur.has(p.id)) cur.delete(p.id);
                                        else cur.add(p.id);
                                        const next = [...actions];
                                        next[idx] = { ...act, infoProfileIds: Array.from(cur) };
                                        setActions(next);
                                      }}
                                    >
                                      {p.kind === 'location' && <MapPin size={11} />}
                                      {p.title}
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Attach Vault Files:</span>
                              {assets.map((a) => {
                                const selected = (act.attachmentIds || []).includes(a.id);
                                return (
                                  <button
                                    key={a.id}
                                    type="button"
                                    className={`btn btn-sm ${selected ? 'btn-primary' : ''}`}
                                    style={{ height: 23, fontSize: 11 }}
                                    onClick={() => {
                                      const cur = new Set(act.attachmentIds || []);
                                      if (cur.has(a.id)) cur.delete(a.id);
                                      else cur.add(a.id);
                                      const next = [...actions];
                                      next[idx] = { ...act, attachmentIds: Array.from(cur) };
                                      setActions(next);
                                    }}
                                  >
                                    <Paperclip size={11} /> {a.filename}
                                  </button>
                                );
                              })}
                              <label className="btn btn-sm" style={{ height: 23, fontSize: 11, cursor: 'pointer' }}>
                                <FilePlus2 size={11} /> Upload File
                                <input
                                  type="file"
                                  hidden
                                  onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = '';
                                    if (!file) return;
                                    const uploaded = await uploadAssetFile(file);
                                    if (uploaded) {
                                      const cur = new Set(act.attachmentIds || []);
                                      cur.add(uploaded.id);
                                      const next = [...actions];
                                      next[idx] = { ...act, attachmentIds: Array.from(cur) };
                                      setActions(next);
                                    }
                                  }}
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => setActions([...actions, { type: 'mark_read' }])}
                    >
                      + Add action
                    </button>
                  </div>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={stopProcessing} onChange={(e) => setStopProcessing(e.target.checked)} />
                  Stop processing lower-priority rules when this rule matches
                </label>

                {previewMatches !== null && (
                  <div style={{ padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)', fontSize: 12.5 }}>
                    <strong>Preview: {previewCount} existing message(s) match this rule</strong>
                    <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                      {previewMatches.slice(0, 6).map((m) => (
                        <li key={m.id}>{m.subject} ({m.fromAddress})</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <button type="button" className="btn" onClick={() => void handlePreview()}>
                    <Eye size={14} /> Preview Matches
                  </button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setCreating(false);
                        resetRuleForm();
                      }}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary">
                      {editingRuleId ? 'Save Changes' : 'Activate Rule'}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {showLogs ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {execLogs.length === 0 ? (
                  <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
                    No rule executions logged yet.
                  </div>
                ) : (
                  execLogs.map((lg) => (
                    <div key={lg.id} style={{ padding: 12, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)', fontSize: 12.5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <strong>{lg.ruleName || 'Rule'} · <span className="chip">{lg.status}</span></strong>
                        <span className="tabular" style={{ color: 'var(--text-muted)' }}>{new Date(lg.executedAt).toLocaleString()}</span>
                      </div>
                      <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>{lg.detail}</div>
                    </div>
                  ))
                )}
              </div>
            ) : rules.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)' }}>
                <Filter size={26} style={{ marginBottom: 8, opacity: 0.5 }} />
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>No active rules yet</div>
                <p style={{ fontSize: 12.5 }}>Create rules to auto-share locations, documents, forward attachments, or triage inbox mail.</p>
              </div>
            ) : (
              rules.map((r, index) => (
                <div
                  key={r.id}
                  style={{
                    padding: 14,
                    borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border-hairline)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>#{index + 1}</span>
                      <strong style={{ fontSize: 14 }}>{r.name}</strong>
                      <span className="chip">{r.enabled ? 'Enabled' : 'Paused'}</span>
                      {r.stopProcessing && <span className="chip">Final</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {r.conditions.map((c) => `${c.field} ${c.operator} "${c.value}"`).join(` ${r.matchMode.toUpperCase()} `)}
                      {' → '}
                      {r.actions
                        .map((a) => {
                          const extras: string[] = [];
                          if (a.value) extras.push(a.value.slice(0, 40));
                          if (a.attachmentIds?.length) extras.push(`${a.attachmentIds.length} file(s)`);
                          if (a.infoProfileIds?.length) extras.push(`${a.infoProfileIds.length} info card(s)`);
                          return `${a.type}${extras.length ? ` (${extras.join(', ')})` : ''}`;
                        })
                        .join(', ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      disabled={index === 0}
                      onClick={() => void handleReorder(index, -1)}
                      title="Move up priority"
                      aria-label={`Move ${r.name} up`}
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      disabled={index === rules.length - 1}
                      onClick={() => void handleReorder(index, 1)}
                      title="Move down priority"
                      aria-label={`Move ${r.name} down`}
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => startEditRule(r)}>
                      <Edit2 size={12} /> Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        const res = await apiRequest<{ appliedCount: number }>(`/org/rules/${r.id}/run`, { method: 'POST' });
                        setStatusBanner(`Rule "${r.name}" matched and updated ${res.appliedCount} message(s).`);
                        onRefreshMail();
                      }}
                    >
                      <Play size={12} /> Run Now
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await apiRequest(`/org/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } });
                        await loadAllAutomations();
                      }}
                    >
                      {r.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      onClick={async () => {
                        await apiRequest(`/org/rules/${r.id}`, { method: 'DELETE' });
                        await loadAllAutomations();
                      }}
                      aria-label={`Delete rule ${r.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </>
        )}

        {/* TAB 2: SCHEDULED & RECURRING MAIL */}
        {tab === 'scheduled' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!schedCreating && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" onClick={applyDaily5amBlueprint}>
                  <Clock size={12} /> Quick Preset: Daily 5:00 AM "Hi" + Attachment
                </button>
              </div>
            )}

            {schedCreating && (
              <form
                onSubmit={handleSaveScheduled}
                style={{
                  padding: 18,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-elevated)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  fontSize: 12.5,
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Automation Name *</label>
                    <input
                      className="field"
                      placeholder="e.g. Daily 5 AM Attendance Check-in"
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Send From Account *</label>
                    <select className="field" value={schedAccountId} onChange={(e) => setSchedAccountId(e.target.value)} required>
                      {activeAccounts.length === 0 ? (
                        <option value="">No mailboxes connected yet</option>
                      ) : (
                        activeAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.emailAddress}</option>
                        ))
                      )}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Repeat Schedule</label>
                    <select
                      className="field"
                      value={schedFrequency}
                      onChange={(e) => setSchedFrequency(e.target.value as ScheduledAutomation['frequency'])}
                    >
                      <option value="daily">Every Day (Daily)</option>
                      <option value="weekdays">Weekdays (Mon–Fri)</option>
                      <option value="weekly">Weekly (Pick Days)</option>
                      <option value="monthly">Monthly (Day 1–28)</option>
                      <option value="interval_hours">Every N Hours</option>
                    </select>
                  </div>

                  {schedFrequency !== 'interval_hours' ? (
                    <div>
                      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Time of Day (24h)</label>
                      <input type="time" className="field" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} required />
                    </div>
                  ) : (
                    <div>
                      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Every (Hours)</label>
                      <input
                        type="number"
                        min={1}
                        max={168}
                        className="field"
                        value={schedIntervalHours}
                        onChange={(e) => setSchedIntervalHours(Number(e.target.value) || 24)}
                      />
                    </div>
                  )}

                  {schedFrequency === 'monthly' && (
                    <div>
                      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Day of Month</label>
                      <input
                        type="number"
                        min={1}
                        max={28}
                        className="field"
                        value={schedDom}
                        onChange={(e) => setSchedDom(Number(e.target.value) || 1)}
                      />
                    </div>
                  )}

                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Timezone</label>
                    <input className="field" value={schedTz} onChange={(e) => setSchedTz(e.target.value)} placeholder="UTC or Asia/Kolkata" />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Max Runs (Optional)</label>
                    <input
                      type="number"
                      min={1}
                      className="field"
                      placeholder="Unlimited"
                      value={schedMaxRuns}
                      onChange={(e) => setSchedMaxRuns(e.target.value)}
                    />
                  </div>
                </div>

                {schedFrequency === 'weekly' && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Days:</span>
                    {WEEKDAY_NAMES.map((label, dayIdx) => {
                      const active = schedDays.includes(dayIdx);
                      return (
                        <button
                          key={label}
                          type="button"
                          className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                          onClick={() =>
                            setSchedDays((prev) =>
                              prev.includes(dayIdx) ? prev.filter((d) => d !== dayIdx) : [...prev, dayIdx].sort()
                            )
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>To Recipients (comma-separated) *</label>
                    <input
                      className="field"
                      placeholder="manager@company.com, team@company.com"
                      value={schedToCsv}
                      onChange={(e) => setSchedToCsv(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Cc Recipients (optional)</label>
                    <input
                      className="field"
                      placeholder="optional@company.com"
                      value={schedCcCsv}
                      onChange={(e) => setSchedCcCsv(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Email Subject *</label>
                  <input className="field" value={schedSubject} onChange={(e) => setSchedSubject(e.target.value)} required />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Message Body</label>
                  <textarea className="field" rows={4} value={schedBody} onChange={(e) => setSchedBody(e.target.value)} />
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Dynamic variables:</span>
                    {['{{date}}', '{{day}}', '{{time}}', '{{google_map_location}}', '{{contact_info}}'].map((tok) => (
                      <button
                        key={tok}
                        type="button"
                        className="chip"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSchedBody((prev) => `${prev}${prev ? ' ' : ''}${tok}`)}
                      >
                        {tok}
                      </button>
                    ))}
                  </div>
                </div>

                {infoProfiles.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Include Shared Info:</span>
                    {infoProfiles.map((p) => {
                      const active = schedInfoIds.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                          onClick={() =>
                            setSchedInfoIds((prev) => (prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id]))
                          }
                        >
                          {p.kind === 'location' && <MapPin size={11} />}
                          {p.title}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Attached Files:</span>
                  {assets.map((a) => {
                    const active = schedAssetIds.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                        onClick={() =>
                          setSchedAssetIds((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]))
                        }
                      >
                        <Paperclip size={11} /> {a.filename} ({formatBytes(a.sizeBytes)})
                      </button>
                    );
                  })}
                  <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                    <FilePlus2 size={12} /> Attach File
                    <input
                      type="file"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        const uploaded = await uploadAssetFile(file);
                        if (uploaded) setSchedAssetIds((prev) => [...prev, uploaded.id]);
                      }}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSchedCreating(false);
                      resetScheduledForm();
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary">
                    {editingSchedId ? 'Save Schedule Changes' : 'Activate Scheduled Email'}
                  </button>
                </div>
              </form>
            )}

            {scheduledList.length === 0 ? (
              <div style={{ padding: 36, textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)' }}>
                <CalendarClock size={26} style={{ marginBottom: 8, opacity: 0.5 }} />
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>No recurring email schedules yet</div>
                <p style={{ fontSize: 12.5 }}>Set up daily or weekly emails with saved attachments and location info (for example: every day at 05:00 AM).</p>
              </div>
            ) : (
              scheduledList.map((s) => (
                <div
                  key={s.id}
                  style={{
                    padding: 14,
                    borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border-hairline)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 240, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{s.name}</strong>
                      <span className="chip">{s.enabled ? 'Active' : 'Paused'}</span>
                      <span className="chip">
                        {s.frequency === 'interval_hours' ? `Every ${s.intervalHours}h` : `${s.frequency} @ ${s.timeOfDay} (${s.timezone})`}
                      </span>
                      {s.attachments.length > 0 && (
                        <span className="chip">
                          <Paperclip size={11} /> {s.attachments.map((a) => a.filename).join(', ')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      From <strong>{s.accountEmail}</strong> → {s.to.map((r) => r.address).join(', ')} · Subject: "{s.subject}"
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      Next run: {new Date(s.nextRunAt).toLocaleString()} · Runs completed: {s.runCount}
                      {s.lastStatus ? ` · Last: ${s.lastStatus}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        setErrorBanner('');
                        try {
                          const res = await apiRequest<{ ok: boolean; attachedFiles: number; error?: string }>(
                            `/automations/scheduled/${s.id}/run`,
                            { method: 'POST' }
                          );
                          if (res.ok) {
                            setStatusBanner(`Dispatched "${s.name}" now with ${res.attachedFiles} attachment(s).`);
                            onRefreshMail();
                            await loadAllAutomations();
                          }
                        } catch (err) {
                          setErrorBanner(err instanceof ApiError ? err.message : 'Manual schedule dispatch failed.');
                        }
                      }}
                    >
                      <Play size={12} /> Send Now
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => startEditScheduled(s)}>
                      <Edit2 size={12} /> Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await apiRequest(`/automations/scheduled/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
                        await loadAllAutomations();
                      }}
                    >
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      onClick={async () => {
                        await apiRequest(`/automations/scheduled/${s.id}`, { method: 'DELETE' });
                        await loadAllAutomations();
                      }}
                      aria-label={`Delete schedule ${s.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}

            {scheduledLogs.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                <strong style={{ fontSize: 12.5 }}>Recent Scheduled Dispatch History</strong>
                {scheduledLogs.slice(0, 10).map((lg) => (
                  <div
                    key={lg.id}
                    style={{
                      padding: 10,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-subtle)',
                      fontSize: 12,
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>
                      <strong>{lg.automationName || 'Schedule'}</strong> · <span className="chip">{lg.status}</span> — {lg.detail}
                    </span>
                    <span className="tabular" style={{ color: 'var(--text-muted)' }}>
                      {new Date(lg.executedAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: SHARED INFO & FILES VAULT */}
        {tab === 'vault' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {infoCreating && (
              <form
                onSubmit={handleSaveInfoProfile}
                style={{
                  padding: 18,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-elevated)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  fontSize: 12.5,
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Info Type</label>
                    <select
                      className="field"
                      value={infoKind}
                      onChange={(e) => setInfoKind(e.target.value as AutomationInfoProfile['kind'])}
                    >
                      <option value="location">Google Maps Location</option>
                      <option value="contact">Contact / Business Card</option>
                      <option value="document">Document / Brochure Pack</option>
                      <option value="custom">Custom Snippet</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Title *</label>
                    <input
                      className="field"
                      placeholder="e.g. Office Location & Parking"
                      value={infoTitle}
                      onChange={(e) => setInfoTitle(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Placeholder Slug</label>
                    <input
                      className="field"
                      placeholder="location (auto if blank)"
                      value={infoSlug}
                      onChange={(e) => setInfoSlug(e.target.value)}
                    />
                  </div>
                </div>

                {infoKind === 'location' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>Address or Lat,Lng Coordinates</label>
                      <input
                        className="field"
                        placeholder="e.g. 123 Park Street, Kolkata or 22.5726,88.3639"
                        value={infoMapQuery}
                        onChange={(e) => setInfoMapQuery(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>
                        Direct Google Maps Share URL (Optional — auto-built from Address if blank)
                      </label>
                      <input
                        className="field"
                        placeholder="https://maps.google.com/?q=..."
                        value={infoMapUrl}
                        onChange={(e) => setInfoMapUrl(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>
                    Details / Directions / Instructions
                  </label>
                  <textarea
                    className="field"
                    rows={3}
                    placeholder="Floor, landmark, phone number, office hours, pricing info..."
                    value={infoContentText}
                    onChange={(e) => setInfoContentText(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Bundled Attachments:</span>
                  {assets.map((a) => {
                    const active = infoAssetIds.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                        onClick={() =>
                          setInfoAssetIds((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]))
                        }
                      >
                        <Paperclip size={11} /> {a.filename}
                      </button>
                    );
                  })}
                  <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                    <FilePlus2 size={12} /> Upload File
                    <input
                      type="file"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        const uploaded = await uploadAssetFile(file);
                        if (uploaded) setInfoAssetIds((prev) => [...prev, uploaded.id]);
                      }}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setInfoCreating(false);
                      resetInfoForm();
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary">
                    {editingInfoId ? 'Save Info Card' : 'Save to Vault'}
                  </button>
                </div>
              </form>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong style={{ fontSize: 13.5 }}>Saved Locations &amp; Shared Information Cards</strong>
              {infoProfiles.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)', fontSize: 12.5 }}>
                  No saved location or info cards yet. Click <strong>Add Info / Location Card</strong> to store your Google Maps location, contact details, or brochure pack.
                </div>
              ) : (
                infoProfiles.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      padding: 14,
                      borderRadius: 'var(--radius-lg)',
                      border: '1px solid var(--border-hairline)',
                      background: 'var(--bg-elevated)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ minWidth: 240, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong>{p.title}</strong>
                        <span className="chip">{p.kind}</span>
                        <code style={{ fontSize: 11 }}>{`{{info:${p.slug}}}`}</code>
                      </div>
                      {p.mapQuery && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{p.mapQuery}</div>}
                      {p.contentText && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{p.contentText}</div>}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                        {p.effectiveMapUrl && (
                          <a
                            href={p.effectiveMapUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-sm"
                            style={{ textDecoration: 'none' }}
                          >
                            <ExternalLink size={11} /> Preview Google Maps Link
                          </a>
                        )}
                        {p.attachments.map((a) => (
                          <span key={a.id} className="chip">
                            <Paperclip size={11} /> {a.filename}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <button type="button" className="btn btn-sm" onClick={() => startEditInfo(p)}>
                        <Edit2 size={12} /> Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={async () => {
                          await apiRequest(`/automations/info/${p.id}`, { method: 'DELETE' });
                          await loadAllAutomations();
                        }}
                        aria-label={`Delete info card ${p.title}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10, borderTop: '1px solid var(--border-hairline)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <strong style={{ fontSize: 13.5 }}>Reusable Automation File Attachments</strong>
                <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                  <FilePlus2 size={13} /> Upload Automation File
                  <input
                    type="file"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) await uploadAssetFile(file);
                    }}
                  />
                </label>
              </div>
              {assets.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)', fontSize: 12.5 }}>
                  <FolderOpen size={20} style={{ opacity: 0.5, marginBottom: 4 }} />
                  <div>No reusable attachments uploaded yet. Upload PDFs, brochures, checklists, or images to attach automatically in rules and scheduled emails.</div>
                </div>
              ) : (
                assets.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      padding: 12,
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-hairline)',
                      background: 'var(--bg-elevated)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <Paperclip size={13} />
                      <strong>{a.filename}</strong>
                      <span className="tabular" style={{ color: 'var(--text-muted)' }}>({formatBytes(a.sizeBytes)})</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <a
                        href={`/api/v1/automations/assets/${a.id}`}
                        download={a.filename}
                        className="btn btn-sm"
                        style={{ textDecoration: 'none' }}
                      >
                        <Download size={12} /> Download
                      </a>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={async () => {
                          await apiRequest(`/automations/assets/${a.id}`, { method: 'DELETE' });
                          await loadAllAutomations();
                        }}
                        aria-label={`Delete file ${a.filename}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
