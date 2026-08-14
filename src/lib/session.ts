import type { Env } from '../types';

/**
 * Session management backed by D1.
 *
 * - The browser only ever holds a random opaque token in an HttpOnly cookie.
 * - The token is stored as SHA-256 hash server-side, so a DB leak does not
 *   expose usable sessions.
 * - Each session carries a CSRF token returned by /api/auth/me; state-changing
 *   API requests must echo it in the `X-CSRF-Token` header.
 */

const SESSION_COOKIE = 'lc_session';
const CSRF_HEADER = 'x-csrf-token';

export interface Session {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: number;
}

export async function createSession(
  env: Env,
  userId: string,
  days = 30,
): Promise<{ session: Session; cookie: string; cookieMaxAge: number }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const id = randomToken(12);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, tokenHash, csrfToken, expiresAt)
    .run();
  const session: Session = { id, userId, csrfToken, expiresAt };
  return { session, cookie: token, cookieMaxAge: days * 86400 };
}

export async function verifySession(env: Env, cookieValue: string | null): Promise<Session | null> {
  if (!cookieValue) return null;
  const tokenHash = await sha256Hex(cookieValue);
  const row = await env.DB.prepare(
    'SELECT id, user_id, csrf_token, expires_at FROM sessions WHERE token_hash = ?',
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; csrf_token: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
    return null;
  }
  return { id: row.id, userId: row.user_id, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export async function deleteSession(env: Env, cookieValue: string | null): Promise<void> {
  if (!cookieValue) return;
  const tokenHash = await sha256Hex(cookieValue);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export function sessionCookieHeader(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function getSessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === SESSION_COOKIE) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Validate the CSRF header for state-changing requests. */
export function verifyCsrf(request: Request, session: Session): boolean {
  const header = request.headers.get(CSRF_HEADER);
  if (!header) return false;
  return constantTimeEqualString(header, session.csrfToken);
}

/** Origin allow-list check: mutations must come from the same origin. */
export function verifyOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser clients
  try {
    const o = new URL(origin);
    const u = new URL(request.url);
    return o.host === u.host;
  } catch {
    return false;
  }
}

export function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}
