import type { Response } from 'express';

export interface ServerEvent {
  type:
    | 'connected'
    | 'sync_started'
    | 'sync_completed'
    | 'sync_error'
    | 'new_message'
    | 'thread_updated'
    | 'draft_updated'
    | 'message_sent'
    | 'send_failed'
    | 'notification'
    | 'reminder_due'
    | 'task_updated'
    | 'calendar_updated'
    | 'automation_executed';
  payload: Record<string, unknown>;
  timestamp: string;
}

class EventBus {
  private clients = new Map<string, Set<Response>>();

  subscribe(userId: string, res: Response): void {
    let set = this.clients.get(userId);
    if (!set) {
      set = new Set();
      this.clients.set(userId, set);
    }
    set.add(res);

    res.on('close', () => {
      set?.delete(res);
      if (set && set.size === 0) {
        this.clients.delete(userId);
      }
    });
  }

  emit(userId: string, type: ServerEvent['type'], payload: Record<string, unknown> = {}): void {
    const set = this.clients.get(userId);
    if (!set || set.size === 0) return;
    const event: ServerEvent = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    const serialized = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      try {
        res.write(serialized);
      } catch {
        // client disconnected
      }
    }
  }

  getActiveClientCount(): number {
    let count = 0;
    for (const set of this.clients.values()) count += set.size;
    return count;
  }
}

export const eventBus = new EventBus();
