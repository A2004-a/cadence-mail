export class ApiError extends Error {
  status: number;
  code?: string;
  data?: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.code = data?.code;
    this.data = data;
  }
}

export class OfflineError extends Error {
  constructor(message = 'You are currently offline') {
    super(message);
  }
}

let csrfToken = '';

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export function getCsrfToken(): string {
  return csrfToken;
}

export async function apiRequest<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  if (typeof navigator !== 'undefined' && !navigator.onLine && method !== 'GET') {
    throw new OfflineError();
  }

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new OfflineError('Network unavailable. Changes will sync when reconnected.');
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}
