import { cfg, isSecureRequest } from './config';
import type { Ctx, Env } from './types';
import { registerBuiltinLinkTypes } from './link-types/handlers';
import { registerPublicRoutes } from './routes/public';
import { registerPageRoutes } from './routes/pages';
import { setupAuthRoutes } from './routes/auth-routes';
import { registerApiRoutes } from './routes/api';
import { registerWebhookRoutes } from './routes/webhook';
import { registerAssetRoutes } from './dashboard/assets';
import { dispatch, notFoundResponse } from './routes/router';
import { memoryCheck } from './lib/ratelimit';
import { SECURITY_HEADERS } from './lib/http';

/**
 * link-center — Link Management + Tracking + Email Control Center.
 *
 * Route families:
 *   /track/:id  /r/:id  /go/:id   public dynamic links (registry-driven)
 *   /dashboard/*                   dashboard SPA shell
 *   /api/*                         JSON API (authenticated)
 *   /api/webhooks/brevo            Brevo transactional webhooks
 *   /login  /setup                 auth pages
 *   /assets/*                      static assets (Cloudflare static assets)
 */

registerBuiltinLinkTypes();
registerPublicRoutes();
setupAuthRoutes();
registerApiRoutes();
registerWebhookRoutes();
registerPageRoutes();
registerAssetRoutes();

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const secure = isSecureRequest(request);
    const requestId = crypto.randomUUID().slice(0, 8);

    // --- robots.txt / favicon -------------------------------------------------
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' },
      });
    }
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, ts: Date.now() }, { headers: SECURITY_HEADERS });
    }

    // --- General API abuse protection (in-memory, per isolate) ----------------
    if (url.pathname.startsWith('/api/')) {
      const c = cfg(env);
      const rl = memoryCheck(`api:${url.hostname}`, c.apiRateLimit, c.apiRateWindow);
      if (!rl.allowed) {
        return Response.json(
          {
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
          },
          {
            status: 429,
            headers: {
              ...SECURITY_HEADERS,
              'Content-Type': 'application/json',
              'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
            },
          },
        );
      }
    }

    const baseCtx: Omit<Ctx, 'params' | 'user'> = {
      request,
      env,
      ctx: executionCtx,
      secure,
      requestId,
    };

    let response: Response | null;
    try {
      response = await dispatch(request, baseCtx);
    } catch (err) {
      console.error(`[worker] ${method} ${url.pathname} failed:`, err);
      response = Response.json(
        { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
        { status: 500 },
      );
    }

    if (!response) {
      // Public link types are already registered as routes; anything else is 404.
      response = notFoundResponse(request);
    }

    // --- Global response hardening -------------------------------------------
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    if (secure) headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    headers.set('X-Request-Id', requestId);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
