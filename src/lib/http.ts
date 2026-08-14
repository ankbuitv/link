import type { ApiError, ApiSuccess } from '../types';

/** Base security headers applied to every response. */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function json<T>(data: T, init: ResponseInit = {}): Response {
  const res = new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
  return res;
}

export function ok<T>(data: T, init: ResponseInit = {}): Response {
  return json<ApiSuccess<T>>({ success: true, data }, init);
}

export function fail(code: string, message: string, status = 400, details?: unknown): Response {
  const body: ApiError = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  return json(body, { status });
}

/** Friendly JSON error for a given HTTP status. */
export function statusError(status: number, code: string, message: string): Response {
  return fail(code, message, status);
}

export const INVALID_REQUEST = (msg = 'Invalid request.') => fail('INVALID_REQUEST', msg, 400);
export const NOT_FOUND = (msg = 'Resource not found.') => fail('NOT_FOUND', msg, 404);
export const UNAUTHORIZED = (msg = 'Authentication required.') => fail('UNAUTHORIZED', msg, 401);
export const FORBIDDEN = (msg = 'You do not have permission to do that.') =>
  fail('FORBIDDEN', msg, 403);
export const RATE_LIMITED = (msg = 'Too many requests. Please try again later.') =>
  fail('RATE_LIMITED', msg, 429);
export const CONFLICT = (msg = 'Conflict with an existing resource.') => fail('CONFLICT', msg, 409);
export const SERVER_ERROR = (msg = 'Internal server error.') => fail('INTERNAL_ERROR', msg, 500);

/** Parse a JSON body safely; returns null on malformed JSON. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    const value = JSON.parse(text);
    return value as T;
  } catch {
    return null;
  }
}

/** Read raw body text safely (for webhooks). */
export async function readRaw(request: Request): Promise<string> {
  return await request.text();
}

/** HTML response with common security headers. */
export function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

/** Redirect response that does not leak referrer. */
export function redirect(url: string, status: 301 | 302 = 302): Response {
  return new Response(null, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      Location: url,
      'Cache-Control': 'no-store',
    },
  });
}
