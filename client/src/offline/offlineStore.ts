import type { EmailMessage, ThreadSummary } from '../types';

const DB_NAME = 'cadence_offline_v1';
const DB_VERSION = 1;

export interface PendingAction {
  id: string;
  endpoint: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body: unknown;
  description: string;
  createdAt: string;
}

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('thread_lists')) db.createObjectStore('thread_lists');
      if (!db.objectStoreNames.contains('thread_details')) db.createObjectStore('thread_details');
      if (!db.objectStoreNames.contains('pending_actions')) db.createObjectStore('pending_actions', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheThreadList(cacheKey: string, threads: ThreadSummary[]): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('thread_lists', 'readwrite');
      tx.objectStore('thread_lists').put({ threads, cachedAt: Date.now() }, cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore storage errors
  }
}

export async function getCachedThreadList(cacheKey: string): Promise<ThreadSummary[] | null> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('thread_lists', 'readonly');
      const req = tx.objectStore('thread_lists').get(cacheKey);
      req.onsuccess = () => resolve(req.result?.threads || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheThreadDetail(
  threadId: string,
  payload: { thread: ThreadSummary; messages: EmailMessage[] }
): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('thread_details', 'readwrite');
      tx.objectStore('thread_details').put(payload, threadId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

export async function getCachedThreadDetail(
  threadId: string
): Promise<{ thread: ThreadSummary; messages: EmailMessage[] } | null> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('thread_details', 'readonly');
      const req = tx.objectStore('thread_details').get(threadId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function enqueuePendingAction(action: Omit<PendingAction, 'id' | 'createdAt'>): Promise<PendingAction> {
  const item: PendingAction = {
    ...action,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending_actions', 'readwrite');
      tx.objectStore('pending_actions').put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
  return item;
}

export async function listPendingActions(): Promise<PendingAction[]> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('pending_actions', 'readonly');
      const req = tx.objectStore('pending_actions').getAll();
      req.onsuccess = () => {
        const list = (req.result || []) as PendingAction[];
        list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function removePendingAction(id: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('pending_actions', 'readwrite');
      tx.objectStore('pending_actions').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}
