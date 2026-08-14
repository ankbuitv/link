import { cfg } from '../config';
import type { Ctx } from '../types';
import { html } from '../lib/http';
import { getSessionCookie, verifySession } from '../lib/session';
import { addRoute } from './router';

/**
 * Dashboard shell + auth gate.
 *
 * Every /dashboard/* path serves the same SPA shell; the client-side app
 * handles sub-routes. If the session cookie is invalid, the shell still loads
 * and the SPA redirects to /login (which keeps things snappy and lets the
 * login page reuse the same bundle for a consistent look).
 */

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Link Center</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔗</text></svg>">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<div id="app" aria-live="polite">
  <div class="boot"><div class="spinner"></div><p>Loading…</p></div>
</div>
<div id="toasts" class="toasts"></div>
<div id="modal-root"></div>
<script src="/assets/app.js" defer></script>
</body>
</html>`;

function dashboardShell(ctx: Ctx): Response {
  const appName = cfg(ctx.env).appName;
  return html(SHELL.replace('<title>Link Center</title>', `<title>${appName}</title>`), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

function registerPageRoutes(): void {
  addRoute('GET', '/dashboard', dashboardShell);
  addRoute('GET', '/dashboard/:rest*', dashboardShell);

  addRoute('GET', '/login', async (ctx: Ctx) => {
    const cookie = getSessionCookie(ctx.request);
    if (cookie && (await verifySession(ctx.env, cookie))) {
      return Response.redirect(new URL('/dashboard', ctx.request.url).toString(), 302);
    }
    return dashboardShell(ctx);
  });

  // Root: bounce to dashboard (or a light public landing).
  addRoute('GET', '/', async (ctx: Ctx) => {
    return Response.redirect(new URL('/dashboard', ctx.request.url).toString(), 302);
  });
}

export { registerPageRoutes, SHELL };
