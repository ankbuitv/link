import { cfg } from '../config';
import { fail, ok, html } from '../lib/http';
import { hashPassword, verifyPassword } from '../lib/password';
import { ipKey, kvCheck } from '../lib/ratelimit';
import { constantTimeEqualString } from '../lib/session';
import {
  clearSessionCookieHeader,
  createSession,
  deleteSession,
  getSessionCookie,
  sessionCookieHeader,
  verifySession,
} from '../lib/session';
import type { Ctx } from '../types';
import { addRoute } from './router';
import { requireUser, usersExist } from './helpers';

/**
 * Authentication routes.
 *  - GET  /setup        first-run admin bootstrap (only when no users exist)
 *  - POST /setup        create the first admin account
 *  - POST /api/auth/login
 *  - POST /api/auth/logout
 *  - GET  /api/auth/me  current session (+ CSRF token for the SPA)
 */

function setupHtml(needsToken: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup — Link Center</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f17;color:#e6edf7;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{max-width:400px;width:92%;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:32px}
  h1{font-size:20px;margin:0 0 6px}
  p.sub{color:#9aa7ba;font-size:13px;margin:0 0 22px}
  label{display:block;font-size:13px;color:#cbd5e1;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;background:#0b0f17;border:1px solid #2a3446;color:#e6edf7;border-radius:8px;padding:10px 12px;font-size:14px;outline:none}
  input:focus{border-color:#2563eb}
  button{width:100%;margin-top:22px;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:11px;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#1d4ed8}
  .err{color:#f87171;font-size:13px;margin-top:14px;min-height:18px}
</style></head><body>
<div class="card">
  <h1>Create admin account</h1>
  <p class="sub">This first-run setup creates the administrator for your link &amp; email control center.</p>
  <form id="f">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32">
    <label for="password">Password (min 10 characters)</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
    <label for="confirm">Confirm password</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10">
    ${needsToken ? '<label for="token">Setup token</label>\n    <input id="token" name="token" type="password" autocomplete="off" required>' : ''}
    <button type="submit">Create account</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.textContent = '';
    const body = {
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
      ${needsToken ? "token: document.getElementById('token').value," : ''}
    };
    const res = await fetch('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) { location.href = '/dashboard'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data?.error?.message || 'Setup failed.';
  });
</script></body></html>`;
}

const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Link Center</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f17;color:#e6edf7;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{max-width:380px;width:92%;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:32px}
  .logo{font-size:28px;margin-bottom:6px}
  h1{font-size:20px;margin:0 0 6px}
  p.sub{color:#9aa7ba;font-size:13px;margin:0 0 22px}
  label{display:block;font-size:13px;color:#cbd5e1;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;background:#0b0f17;border:1px solid #2a3446;color:#e6edf7;border-radius:8px;padding:10px 12px;font-size:14px;outline:none}
  input:focus{border-color:#2563eb}
  button{width:100%;margin-top:22px;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:11px;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#1d4ed8}
  .err{color:#f87171;font-size:13px;margin-top:14px;min-height:18px}
</style></head><body>
<div class="card">
  <div class="logo">🔗</div>
  <h1>Sign in to Link Center</h1>
  <p class="sub">Manage links, analytics and transactional email.</p>
  <form id="f">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.textContent = '';
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    if (res.ok) { location.href = '/dashboard'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data?.error?.message || 'Sign-in failed.';
  });
</script></body></html>`;

function setupAuthRoutes(): void {
  addRoute('GET', '/setup', async (ctx: Ctx) => {
    if (await usersExist(ctx.env)) {
      return html('<!doctype html><title>404</title><p>Not found.</p>', { status: 404 });
    }
    return html(setupHtml(Boolean(ctx.env.SETUP_TOKEN)));
  });

  addRoute('POST', '/setup', async (ctx: Ctx) => {
    if (await usersExist(ctx.env)) {
      return fail('SETUP_DONE', 'Setup has already been completed.', 404);
    }
    const body = (await ctx.request.json().catch(() => null)) as Record<string, unknown> | null;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    // Optional first-run hardening: when SETUP_TOKEN is configured it must
    // match, otherwise anyone could claim the admin account before you do.
    if (ctx.env.SETUP_TOKEN) {
      const provided = typeof body?.token === 'string' ? body.token : '';
      if (!constantTimeEqualString(provided, ctx.env.SETUP_TOKEN)) {
        return fail('INVALID_SETUP_TOKEN', 'Invalid setup token.', 403);
      }
    }
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      return fail('INVALID_USERNAME', 'Username must be 3-32 characters (letters, numbers, dot, dash, underscore).', 400);
    }
    if (password.length < 10) {
      return fail('WEAK_PASSWORD', 'Password must be at least 10 characters.', 400);
    }
    if (password.length > 256) {
      return fail('INVALID_PASSWORD', 'Password is too long.', 400);
    }
    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    try {
      await ctx.env.DB.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, passwordHash, 'admin', now)
        .run();
    } catch (err) {
      const msg = err instanceof Error && err.message.includes('UNIQUE') ? 'That username is taken.' : 'Could not create the account.';
      return fail('SETUP_FAILED', msg, 500);
    }
    const { cookie, cookieMaxAge } = await createSession(ctx.env, id, cfg(ctx.env).sessionDays);
    return ok(
      { user: { id, username, role: 'admin' } },
      { status: 201, headers: { 'Set-Cookie': sessionCookieHeader(cookie, cookieMaxAge, ctx.secure) } },
    );
  });

  addRoute('POST', '/api/auth/login', async (ctx: Ctx) => {
    // Rate limit per IP (KV-backed, shared across regions).
    const c = cfg(ctx.env);
    const rl = await kvCheck(ctx.env, ipKey('login', ctx.request), c.loginRateLimit, c.loginRateWindow);
    if (!rl.allowed) {
      return fail('RATE_LIMITED', 'Too many sign-in attempts. Try again later.', 429, { resetAt: rl.resetAt });
    }
    const body = (await ctx.request.json().catch(() => null)) as Record<string, unknown> | null;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      return fail('INVALID_REQUEST', 'Username and password are required.', 400);
    }
    const user = await ctx.env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(username)
      .first<{ id: string; username: string; password_hash: string; role: string }>();
    // Constant-time-ish check: hash even when the user is missing.
    const okPassword = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, '$pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!user || !okPassword) {
      return fail('INVALID_CREDENTIALS', 'Invalid username or password.', 401);
    }
    const { session, cookie, cookieMaxAge } = await createSession(ctx.env, user.id, c.sessionDays);
    return ok(
      {
        user: { id: user.id, username: user.username, role: user.role },
        csrfToken: session.csrfToken,
      },
      { headers: { 'Set-Cookie': sessionCookieHeader(cookie, cookieMaxAge, ctx.secure) } },
    );
  });

  addRoute('POST', '/api/auth/logout', async (ctx: Ctx) => {
    const cookie = getSessionCookie(ctx.request);
    await deleteSession(ctx.env, cookie);
    return ok({ loggedOut: true }, { headers: { 'Set-Cookie': clearSessionCookieHeader(ctx.secure) } });
  });

  addRoute('GET', '/api/auth/me', async (ctx: Ctx) => {
    const auth = await requireUser(ctx);
    if (auth instanceof Response) return auth;
    const cookie = getSessionCookie(ctx.request);
    const session = await verifySession(ctx.env, cookie);
    return ok({
      user: { id: auth.user.id, username: auth.user.username, role: auth.user.role },
      csrfToken: session?.csrfToken ?? null,
      settings: undefined,
    });
  });
}

export { setupAuthRoutes, LOGIN_HTML };
