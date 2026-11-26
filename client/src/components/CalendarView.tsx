import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Download, Edit2, Plus, Trash2 } from 'lucide-react';
import { apiRequest } from '../api/client';
import type { CalendarEvent } from '../types';

type CalendarMode = 'month' | 'week' | 'day' | 'agenda';

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CalendarView({
  onOpenThread,
}: {
  onOpenThread: (threadId: string) => void;
}) {
  const [mode, setMode] = useState<CalendarMode>('agenda');
  const [cursorDate, setCursorDate] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [providerNotes, setProviderNotes] = useState<Array<{ emailAddress: string; providerType: string; note: string }>>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [icsImportOpen, setIcsImportOpen] = useState(false);
  const [icsText, setIcsText] = useState('');
  const [editing, setEditing] = useState<CalendarEvent | null>(null);

  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [location, setLocation] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [description, setDescription] = useState('');
  const [attendeesCsv, setAttendeesCsv] = useState('');

  async function load() {
    const [evRes, provRes] = await Promise.all([
      apiRequest<{ events: CalendarEvent[] }>('/workspace/calendar'),
      apiRequest<{ providers: Array<{ emailAddress: string; providerType: string; note: string }> }>('/workspace/calendar/provider-status'),
    ]);
    setEvents(evRes.events);
    setProviderNotes(provRes.providers || []);
  }

  useEffect(() => {
    void load();
  }, []);

  function openNewEvent(baseDate?: Date) {
    const d = baseDate ? new Date(baseDate) : new Date();
    d.setMinutes(0, 0, 0);
    if (!baseDate) d.setHours(d.getHours() + 1);
    const end = new Date(d.getTime() + 3600_000);
    setEditing(null);
    setTitle('');
    setStartAt(toLocalInput(d.toISOString()));
    setEndAt(toLocalInput(end.toISOString()));
    setLocation('');
    setMeetingUrl('');
    setDescription('');
    setAttendeesCsv('');
    setModalOpen(true);
  }

  function openEditEvent(ev: CalendarEvent) {
    setEditing(ev);
    setTitle(ev.title);
    setStartAt(toLocalInput(ev.startAt));
    setEndAt(toLocalInput(ev.endAt));
    setLocation(ev.location || '');
    setMeetingUrl(ev.meetingUrl || '');
    setDescription(ev.description || '');
    setAttendeesCsv(ev.attendees.map((a) => a.address).join(', '));
    setModalOpen(true);
  }

  async function saveEvent(e: React.FormEvent) {
    e.preventDefault();
    const attendees = attendeesCsv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
      .map((address) => ({ name: '', address }));

    const payload = {
      title: title.trim(),
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      location,
      meetingUrl,
      description,
      attendees,
    };

    if (editing) {
      await apiRequest(`/workspace/calendar/${editing.id}`, { method: 'PATCH', body: payload });
    } else {
      await apiRequest('/workspace/calendar', { method: 'POST', body: payload });
    }
    setModalOpen(false);
    await load();
  }

  const monthDays = useMemo(() => {
    const year = cursorDate.getFullYear();
    const month = cursorDate.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const days: Date[] = [];
    for (let i = -startOffset; i < 42 - startOffset; i++) {
      days.push(new Date(year, month, 1 + i));
    }
    return days;
  }, [cursorDate]);

  const weekDays = useMemo(() => {
    const start = new Date(cursorDate);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [cursorDate]);

  const filteredEvents = useMemo(() => {
    const dayKey = cursorDate.toDateString();
    if (mode === 'day') {
      return events.filter((e) => new Date(e.startAt).toDateString() === dayKey);
    }
    if (mode === 'week') {
      const start = weekDays[0].getTime();
      const end = weekDays[6].getTime() + 86_400_000;
      return events.filter((e) => {
        const ms = new Date(e.startAt).getTime();
        return ms >= start && ms < end;
      });
    }
    return events;
  }, [events, mode, cursorDate, weekDays]);

  function stepCursor(dir: -1 | 1) {
    const next = new Date(cursorDate);
    if (mode === 'month') next.setMonth(next.getMonth() + dir);
    else if (mode === 'week') next.setDate(next.getDate() + dir * 7);
    else next.setDate(next.getDate() + dir);
    setCursorDate(next);
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 24, background: 'var(--bg-canvas)' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 18.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CalendarClock size={18} color="var(--accent)" /> Calendar
            </h1>
            <div style={{ display: 'flex', gap: 4 }}>
              <button type="button" className="btn btn-sm" onClick={() => stepCursor(-1)} aria-label="Previous period">
                <ChevronLeft size={14} />
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setCursorDate(new Date())}>
                Today
              </button>
              <button type="button" className="btn btn-sm" onClick={() => stepCursor(1)} aria-label="Next period">
                <ChevronRight size={14} />
              </button>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              {cursorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {(['agenda', 'day', 'week', 'month'] as CalendarMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`btn btn-sm ${mode === m ? 'btn-primary' : ''}`}
                style={{ textTransform: 'capitalize' }}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setIcsImportOpen(true)}>
              Import .ICS
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => openNewEvent()}>
              <Plus size={14} /> New Event
            </button>
          </div>
        </div>

        {providerNotes.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--bg-subtle)' }}>
            {providerNotes.map((p) => `${p.emailAddress}: ${p.note}`).join(' · ')}
          </div>
        )}

        {mode === 'month' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              background: 'var(--bg-elevated)',
            }}
          >
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} style={{ padding: '8px 10px', fontSize: 11.5, fontWeight: 600, background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-hairline)' }}>
                {d}
              </div>
            ))}
            {monthDays.map((day, idx) => {
              const dayEvents = events.filter((ev) => new Date(ev.startAt).toDateString() === day.toDateString());
              const isCurMonth = day.getMonth() === cursorDate.getMonth();
              const isToday = day.toDateString() === new Date().toDateString();
              return (
                <div
                  key={idx}
                  style={{
                    minHeight: 96,
                    padding: 6,
                    borderRight: (idx + 1) % 7 !== 0 ? '1px solid var(--border-hairline)' : undefined,
                    borderBottom: '1px solid var(--border-hairline)',
                    opacity: isCurMonth ? 1 : 0.45,
                  }}
                  onDoubleClick={() => openNewEvent(day)}
                >
                  <div className="tabular" style={{ fontSize: 11.5, fontWeight: isToday ? 700 : 500, color: isToday ? 'var(--accent)' : 'var(--text-secondary)', marginBottom: 4 }}>
                    {day.getDate()}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {dayEvents.slice(0, 3).map((ev) => (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => openEditEvent(ev)}
                        style={{
                          textAlign: 'left',
                          border: 'none',
                          borderRadius: 'var(--radius-xs)',
                          padding: '2px 5px',
                          fontSize: 11,
                          background: 'var(--accent-soft)',
                          color: 'var(--accent)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          cursor: 'pointer',
                        }}
                      >
                        {new Date(ev.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {ev.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredEvents.length === 0 ? (
              <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
                No events scheduled for this view. Click <strong>New Event</strong> or extract meeting details directly from an email workflow.
              </div>
            ) : (
              filteredEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="cadence-hub-card"
                  style={{
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{ev.title}</strong>
                      <span className="chip" style={{ height: 20, fontSize: 10.5, textTransform: 'capitalize' }}>{ev.source}</span>
                      {ev.location && <span className="chip" style={{ height: 20, fontSize: 10.5 }}>{ev.location}</span>}
                    </div>
                    <div className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                      {new Date(ev.startAt).toLocaleString()} – {new Date(ev.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {ev.description && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{ev.description}</div>}
                    {ev.threadId && (
                      <button
                        type="button"
                        style={{ border: 'none', background: 'transparent', padding: 0, color: 'var(--accent)', fontSize: 11.5, marginTop: 4, cursor: 'pointer' }}
                        onClick={() => onOpenThread(ev.threadId!)}
                      >
                        Open linked email: {ev.threadSubject || 'Conversation'}
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <a
                      href={`/api/v1/workspace/calendar/${ev.id}/ics`}
                      className="btn btn-ghost btn-icon"
                      title="Export .ICS"
                      aria-label={`Export ${ev.title} to ICS`}
                    >
                      <Download size={14} />
                    </a>
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => openEditEvent(ev)} aria-label={`Edit ${ev.title}`}>
                      <Edit2 size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      onClick={async () => {
                        await apiRequest(`/workspace/calendar/${ev.id}`, { method: 'DELETE' });
                        await load();
                      }}
                      aria-label={`Delete ${ev.title}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editing ? 'Edit event' : 'New calendar event'}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }}
          onClick={() => setModalOpen(false)}
        >
          <form
            onSubmit={saveEvent}
            style={{ width: '100%', maxWidth: 460, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', padding: 20, border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15 }}>{editing ? 'Edit Event' : 'Create Calendar Event'}</strong>
            <input className="field" placeholder="Event title" value={title} onChange={(e) => setTitle(e.target.value)} required />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Start</label>
                <input type="datetime-local" className="field" value={startAt} onChange={(e) => setStartAt(e.target.value)} required />
              </div>
              <div>
                <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>End</label>
                <input type="datetime-local" className="field" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
              </div>
            </div>
            <input className="field" placeholder="Location or room (optional)" value={location} onChange={(e) => setLocation(e.target.value)} />
            <input className="field" placeholder="Meeting URL (optional)" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} />
            <input className="field" placeholder="Attendee emails (comma separated)" value={attendeesCsv} onChange={(e) => setAttendeesCsv(e.target.value)} />
            <textarea className="field" rows={3} placeholder="Agenda / notes" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setModalOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Event</button>
            </div>
          </form>
        </div>
      )}

      {icsImportOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import ICS events"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }}
          onClick={() => setIcsImportOpen(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/workspace/calendar/import-ics', { method: 'POST', body: { icsText } });
              setIcsText('');
              setIcsImportOpen(false);
              await load();
            }}
            style={{ width: '100%', maxWidth: 500, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)', padding: 20, border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong>Import RFC 5545 (.ics) Calendar Invitation</strong>
            <textarea className="field mono" rows={8} placeholder="Paste BEGIN:VCALENDAR ... END:VCALENDAR contents" value={icsText} onChange={(e) => setIcsText(e.target.value)} required />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setIcsImportOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Import Events</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
