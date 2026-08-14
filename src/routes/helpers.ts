import type { Ctx, UserRow } from '../types';
import { hashPassword, verifyPassword } from '../lib/password';
import {
  clearSessionCookieHeader,
  createSession,
  deleteSession,
  getSessionCookie,
  sessionCookieHeader,
  verifyCsrf,
  verifyOrigin,
  verifySession,
} from '../lib/session';
import { FORBIDDEN, UNAUTHORIZED, ok } from '../lib/http';

export interface AuthResult {
  user: UserRow;
}

/**
 * Resolve the authenticated user for a request.
 * - checks the session cookie,
 * - verifies the session exists and has not expired,
 * - refreshes last_seen_at.
 */
export async function requireUser(ctx: Ctx): Promise<AuthResult | Response> {
  const cookie = getSessionCookie(ctx.request);
  if (!cookie) return UNAUTHORIZED('Authentication required.');
  const session = await verifySession(ctx.env, cookie);
  if (!session) return UNAUTHORIZED('Session expired. Please sign in again.');
  const user = await ctx.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(session.userId)
    .first<UserRow>();
  if (!user) return UNAUTHORIZED('Account no longer exists.');
  // Touch last_seen (throttled by the session expiry anyway).
  ctx.ctx.waitUntil(
    ctx.env.DB.prepare('UPDATE sessions SET last_seen_at = unixepoch() WHERE id = ?')
      .bind(session.id)
      .run()
      .catch(() => {}),
  );
  ctx.user = user;
  return { user };
}

/** Require auth for state-changing API calls (CSRF + Origin checks). */
export async function requireUserMutation(ctx: Ctx): Promise<AuthResult | Response> {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const cookie = getSessionCookie(ctx.request);
  const session = await verifySession(ctx.env, cookie);
  if (!session) return UNAUTHORIZED('Session expired.');
  if (!verifyOrigin(ctx.request)) {
    return FORBIDDEN('Cross-origin requests are not allowed.');
  }
  if (!verifyCsrf(ctx.request, session)) {
    return FORBIDDEN('Invalid or missing CSRF token.');
  }
  return auth;
}

/** True when the users table is empty (first-run bootstrap). */
export async function usersExist(env: Ctx['env']): Promise<boolean> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

export { createSession, sessionCookieHeader, clearSessionCookieHeader, deleteSession, hashPassword, verifyPassword, ok };
