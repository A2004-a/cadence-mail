import React, { useEffect, useState } from 'react';
import { Check, CheckSquare, Clock, Edit2, Plus, Trash2 } from 'lucide-react';
import { apiRequest } from '../api/client';
import type { TaskItem } from '../types';

type TaskFilterView = 'all' | 'today' | 'upcoming' | 'overdue' | 'completed';

const PRIORITY_COLORS: Record<TaskItem['priority'], { bg: string; color: string }> = {
  urgent: { bg: 'var(--status-danger-bg)', color: 'var(--status-danger)' },
  high: { bg: 'var(--status-warning-bg)', color: 'var(--status-warning)' },
  medium: { bg: 'var(--accent-soft)', color: 'var(--accent)' },
  low: { bg: 'var(--bg-badge)', color: 'var(--text-muted)' },
};

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TasksView({
  onOpenThread,
  onCountChange,
}: {
  onOpenThread: (threadId: string) => void;
  onCountChange?: (openCount: number) => void;
}) {
  const [view, setView] = useState<TaskFilterView>('all');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState<TaskItem['priority']>('medium');
  const [category, setCategory] = useState('Work');
  const [dueAt, setDueAt] = useState('');
  const [editing, setEditing] = useState<TaskItem | null>(null);

  async function loadTasks(targetView = view) {
    setLoading(true);
    try {
      const [viewRes, allRes] = await Promise.all([
        apiRequest<{ tasks: TaskItem[] }>(`/workspace/tasks?view=${targetView}`),
        targetView === 'all'
          ? Promise.resolve(null)
          : apiRequest<{ tasks: TaskItem[] }>('/workspace/tasks?view=all'),
      ]);
      setTasks(viewRes.tasks);
      const allList = allRes ? allRes.tasks : viewRes.tasks;
      onCountChange?.(allList.filter((t) => t.status !== 'completed').length);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTasks(view);
  }, [view]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (editing) {
      await apiRequest(`/workspace/tasks/${editing.id}`, {
        method: 'PATCH',
        body: {
          title: title.trim(),
          notes,
          priority,
          category: category || 'General',
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        },
      });
    } else {
      await apiRequest('/workspace/tasks', {
        method: 'POST',
        body: {
          title: title.trim(),
          notes,
          priority,
          category: category || 'General',
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        },
      });
    }
    setEditing(null);
    setTitle('');
    setNotes('');
    setPriority('medium');
    setDueAt('');
    await loadTasks(view);
  }

  function startEdit(task: TaskItem) {
    setEditing(task);
    setTitle(task.title);
    setNotes(task.notes || '');
    setPriority(task.priority);
    setCategory(task.category || 'General');
    setDueAt(toLocalInput(task.dueAt));
  }

  const navItems: Array<{ id: TaskFilterView; label: string }> = [
    { id: 'all', label: 'All Tasks' },
    { id: 'today', label: 'Today' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'completed', label: 'Completed' },
  ];

  return (
    <div className="cadence-subview-shell">
      <div className="cadence-subview-nav">
        <strong style={{ fontSize: 13.5, padding: '4px 10px 8px' }}>Task Views</strong>
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="btn btn-ghost btn-sm"
            style={{
              justifyContent: 'flex-start',
              background: view === item.id ? 'var(--accent-soft)' : 'transparent',
              color: view === item.id ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: view === item.id ? 600 : 500,
            }}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
        <div style={{ maxWidth: 840, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 18.5, fontWeight: 700, letterSpacing: '-0.02em' }}>Tasks</h1>
              <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
                Manage action items extracted from conversations, automation rules, and personal workflows.
              </p>
            </div>
          </div>

          <form
            onSubmit={handleSubmit}
            style={{
              padding: 16,
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-elevated)',
              boxShadow: 'var(--shadow-sm)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="field"
                style={{ flex: 2, minWidth: 220 }}
                placeholder={editing ? 'Update task title...' : 'Add a task...'}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
              <select
                className="field"
                style={{ width: 130 }}
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskItem['priority'])}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <input
                className="field"
                style={{ width: 130 }}
                placeholder="Category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
              <input
                type="datetime-local"
                className="field"
                style={{ width: 190 }}
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="field"
                placeholder="Notes (optional)..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              {editing && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditing(null);
                    setTitle('');
                    setNotes('');
                    setDueAt('');
                  }}
                >
                  Cancel
                </button>
              )}
              <button type="submit" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>
                <Plus size={14} /> {editing ? 'Update Task' : 'Create Task'}
              </button>
            </div>
          </form>

          {loading ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : tasks.length === 0 ? (
            <div
              className="cadence-hub-card"
              style={{
                padding: 36,
                textAlign: 'center',
                borderRadius: 'var(--radius-xl)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
              }}
            >
              <CheckSquare size={26} style={{ opacity: 0.45, marginBottom: 8 }} />
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>No tasks in {navItems.find((n) => n.id === view)?.label}</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>Create one above or extract action items via AI Workflows or Rules.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tasks.map((task) => {
                const priStyle = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium;
                const isDone = task.status === 'completed';
                return (
                  <div
                    key={task.id}
                    className="cadence-hub-card"
                    style={{
                      padding: '12px 14px',
                      borderRadius: 'var(--radius-lg)',
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-elevated)',
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 12,
                      opacity: isDone ? 0.65 : 1,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0, flex: 1 }}>
                      <button
                        type="button"
                        className={`btn btn-sm ${isDone ? 'btn-primary' : ''}`}
                        style={{ width: 26, height: 26, padding: 0, marginTop: 2, borderRadius: 99 }}
                        onClick={async () => {
                          await apiRequest(`/workspace/tasks/${task.id}`, {
                            method: 'PATCH',
                            body: { status: isDone ? 'todo' : 'completed' },
                          });
                          await loadTasks(view);
                        }}
                        aria-label={isDone ? `Mark ${task.title} incomplete` : `Complete ${task.title}`}
                      >
                        <Check size={13} />
                      </button>

                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 14, textDecoration: isDone ? 'line-through' : 'none' }}>{task.title}</strong>
                          <span className="chip" style={{ height: 20, fontSize: 10.5, background: priStyle.bg, color: priStyle.color, textTransform: 'capitalize' }}>
                            {task.priority}
                          </span>
                          <span className="chip" style={{ height: 20, fontSize: 10.5 }}>{task.category}</span>
                        </div>
                        {task.notes && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{task.notes}</div>}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
                          {task.dueAt && (
                            <span className="tabular" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <Clock size={11} /> Due {new Date(task.dueAt).toLocaleString()}
                            </span>
                          )}
                          {task.contactName && <span>Contact: {task.contactName}</span>}
                          {task.threadId && (
                            <button
                              type="button"
                              style={{ border: 'none', background: 'transparent', padding: 0, color: 'var(--accent)', fontSize: 11.5, cursor: 'pointer' }}
                              onClick={() => onOpenThread(task.threadId!)}
                            >
                              Open email: {task.threadSubject || 'Linked thread'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        style={{ width: 28, height: 28 }}
                        onClick={() => startEdit(task)}
                        aria-label={`Edit ${task.title}`}
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        style={{ width: 28, height: 28 }}
                        onClick={async () => {
                          await apiRequest(`/workspace/tasks/${task.id}`, { method: 'DELETE' });
                          await loadTasks(view);
                        }}
                        aria-label={`Delete ${task.title}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
