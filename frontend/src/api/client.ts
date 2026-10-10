// Single fetch wrapper for /api/* (docs/API.md conventions).

export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}

// Set by the session layer; called when any request gets a 401.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

// A persona change invalidates reads made under the previous session.
let sessionEpoch = 0;
let sessionChanging = false;
const pendingReads = new Set<AbortController>();
const cancelled = () => new ApiError(0, 'cancelled', 'Request cancelled.');

export function beginPersonaSwitch() {
  sessionChanging = true;
  sessionEpoch += 1;
  for (const controller of pendingReads) controller.abort();
  pendingReads.clear();
}

export function finishPersonaSwitch() {
  sessionChanging = false;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface RequestOpts {
  method?: string;
  query?: Query | undefined;
  body?: unknown;
  formData?: FormData | undefined;
  idempotencyKey?: string | undefined;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  if (sessionChanging && (opts.method ?? 'GET') === 'GET' && path !== '/me') throw cancelled();
  const epoch = sessionEpoch;
  const controller = new AbortController();
  const read = (opts.method ?? 'GET') === 'GET';
  if (read) pendingReads.add(controller);
  try {
    return await requestApi<T>(path, opts, controller.signal, epoch);
  } finally {
    pendingReads.delete(controller);
  }
}

async function requestApi<T>(path: string, opts: RequestOpts, signal: AbortSignal, epoch: number): Promise<T> {
  const checkSession = () => { if (signal.aborted || epoch !== sessionEpoch) throw cancelled(); };
  const headers: Record<string, string> = {};
  const method = opts.method ?? 'GET';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(opts.query)}`, {
      method,
      credentials: 'same-origin',
      signal,
      headers,
      body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : null),
    });
  } catch {
    checkSession();
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }

  checkSession();
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, 'unauthenticated', 'You are signed out.');
  }
  if (res.status === 204) return undefined as T;

  let text: string;
  try {
    text = await res.text();
  } catch {
    checkSession();
    throw new ApiError(0, 'network', 'Could not read the response. Check your connection.');
  }
  checkSession();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  if (method !== 'GET' && !path.startsWith('/demo/login') && path !== '/demo/clock') window.dispatchEvent(new Event('nld:counts-changed'));
  return data as T;
}

export const get = <T>(path: string, query?: Query | undefined) =>
  api<T>(path, { query });
export const post = <T>(path: string, body?: unknown, idempotencyKey?: string) =>
  api<T>(path, { method: 'POST', body: body ?? {}, idempotencyKey });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string, query?: Query) =>
  api<T>(path, { method: 'DELETE', query });
export const postForm = <T>(path: string, formData: FormData, idempotencyKey?: string) =>
  api<T>(path, { method: 'POST', formData, idempotencyKey });

// API.md documents {items,total} envelopes for paginated lists, but several
// list endpoints do not specify the envelope. Accept both.
export function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.items)) return d.items as T[];
    if (Array.isArray(d.rows)) return d.rows as T[];
  }
  return [];
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
