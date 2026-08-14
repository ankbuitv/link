import { env, SELF } from 'cloudflare:test';
import type { Env } from '../src/types';
import { applyMigrations } from './db-setup';

/** Test helpers: admin bootstrap, authenticated requests, async flush. */

export const ADMIN = { username: 'admin', password: 'correct-horse-battery-staple' };

let sessionCookie: string | null = null;
let csrfToken: string | null = null;

/** Create the admin account once per test file (setup endpoint). */
export async function setupAdmin(): Promise<void> {
  await applyMigrations();
  const res = await SELF.fetch('https://example.com/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (res.status === 404) {
    // Setup already done (tests share state) — sign in instead.
    await login();
    return;
  }
  if (!res.ok) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  sessionCookie = extractCookie(res.headers.get('Set-Cookie'));
  await refreshCsrf();
}

export async function login(username = ADMIN.username, password = ADMIN.password, ip = '198.51.100.7'): Promise<void> {
  const res = await SELF.fetch('https://example.com/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  sessionCookie = extractCookie(res.headers.get('Set-Cookie'));
  await refreshCsrf();
}

async function refreshCsrf(): Promise<void> {
  const me = await authedFetch('/api/auth/me', {}, { withCsrf: false });
  const data = (await me.json()) as { data?: { csrfToken?: string | null } };
  csrfToken = data.data?.csrfToken ?? null;
}

export function extractCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error('no Set-Cookie header');
  const part = setCookie.split(';')[0]!;
  return part.slice(part.indexOf('=') + 1);
}

/** Authenticated request with CSRF + Origin headers (mutation-ready). */
export async function authedFetch(
  path: string,
  init: RequestInit = {},
  opts: { withCsrf?: boolean; origin?: string; ip?: string } = {},
): Promise<Response> {
  if (!sessionCookie) throw new Error('not authenticated — call setupAdmin() first');
  const headers = new Headers(init.headers || {});
  headers.set('Cookie', `lc_session=${sessionCookie}`);
  headers.set('CF-Connecting-IP', opts.ip || '198.51.100.7');
  if (opts.withCsrf !== false) {
    if (!csrfToken) throw new Error('no CSRF token — call setupAdmin() first');
    headers.set('X-CSRF-Token', csrfToken);
  }
  headers.set('Origin', opts.origin || 'https://example.com');
  // manual: assert on redirects (302) instead of following them
  return SELF.fetch('https://example.com' + path, { ...init, headers, redirect: 'manual' });
}

/** Unauthenticated request. */
export function anonFetch(path: string, init: RequestInit = {}, ip = '203.0.113.9'): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set('CF-Connecting-IP', ip);
  return SELF.fetch('https://example.com' + path, { ...init, headers, redirect: 'manual' });
}

/** Poll until a DB predicate is true (waitUntil analytics writes settle). */
export async function flushUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 6000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function dbCount(table: string, where = ''): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export function jsonBody(data: unknown): BodyInit {
  return JSON.stringify(data);
}

export { env };
export type { Env };
