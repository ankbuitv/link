import type { Ctx } from '../types';
import { html, json } from '../lib/http';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  method: HttpMethod;
  /** Path pattern: '/api/links/:id/analytics' (':name' = one segment). */
  pattern: string;
  handler: (ctx: Ctx) => Promise<Response> | Response;
}

const routes: Route[] = [];

export function addRoute(method: HttpMethod, pattern: string, handler: Route['handler']): void {
  routes.push({ method, pattern, handler });
}

function match(pattern: string, pathname: string): { params: Ctx['params'] } | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  const params: Ctx['params'] = {};
  for (let i = 0; i < p.length; i++) {
    const pp = p[i]!;
    // Trailing wildcard: '/dashboard/:rest*'
    if (pp.endsWith('*') && pp.startsWith(':')) {
      params[pp.slice(1, -1)] = s.slice(i).map(decodeURIComponent).join('/');
      return { params };
    }
    const sp = s[i];
    if (sp === undefined) return null;
    if (pp.startsWith(':')) {
      params[pp.slice(1)] = decodeURIComponent(sp);
    } else if (pp !== sp) {
      return null;
    }
  }
  if (s.length !== p.length) return null;
  return { params };
}

export async function dispatch(
  request: Request,
  ctxBase: Omit<Ctx, 'params' | 'user'>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase() as HttpMethod;

  for (const route of routes) {
    if (route.method !== method) continue;
    const m = match(route.pattern, pathname);
    if (!m) continue;
    const ctx: Ctx = { ...ctxBase, params: m.params };
    try {
      return await route.handler(ctx);
    } catch (err) {
      console.error(`[router] ${method} ${pathname} failed:`, err);
      return json(
        {
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
        },
        { status: 500 },
      );
    }
  }
  return null;
}

export function notFoundResponse(request: Request): Response {
  const url = new URL(request.url);
  // JSON for API-ish paths, friendly HTML otherwise.
  if (url.pathname.startsWith('/api/')) {
    return json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, { status: 404 });
  }
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — Page not found</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f17;color:#e6edf7;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{max-width:420px;width:90%;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:36px 32px;text-align:center}
  .code{font-size:52px;line-height:1;margin-bottom:12px}
  h1{font-size:20px;margin:0 0 8px}
  p{margin:0;color:#9aa7ba;font-size:14px}
  a{display:inline-block;margin-top:20px;color:#60a5fa;text-decoration:none;font-size:14px}
</style></head><body>
<div class="card"><div class="code">404</div>
<h1>Page not found</h1>
<p>The page you are looking for does not exist.</p>
<a href="/">Go to dashboard</a>
</div></body></html>`,
    { status: 404 },
  );
}
