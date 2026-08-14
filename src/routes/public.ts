import { cfg } from '../config';
import type { Ctx } from '../types';
import { getLinkBySlugCached } from '../lib/db-links';
import { html } from '../lib/http';
import { sanitizePublicSlug } from '../lib/slug';
import {
  handlePublicLink,
  linkErrorPage,
  linkTypeDefinitions,
  matchPath,
  type LinkTypeDefinition,
} from '../link-types/registry';
import { addRoute } from './router';

/**
 * Public dynamic link routes.
 *
 * The router registers one wildcard-ish route per link-type path pattern
 * (/track/:id, /r/:id, /go/:id). The registry (link-types/registry.ts)
 * holds the actual handlers; new types are added there, not here.
 */

function friendlyError(status: number, title: string, message: string, ctx: Ctx): Response {
  const appName = cfg(ctx.env).appName;
  return linkErrorPage(title, message, appName);
}

function publicLinkHandler(def: LinkTypeDefinition) {
  return async (ctx: Ctx): Promise<Response> => {
    const id = (ctx.params.id || '').trim();
    if (!id) {
      return friendlyError(404, 'Not Found', 'This link does not exist.', ctx);
    }
    const slug = sanitizePublicSlug(id);
    if (!slug || slug.length < 2) {
      return friendlyError(404, 'Not Found', 'This link does not exist.', ctx);
    }

    const link = await getLinkBySlugCached(ctx.env, slug);
    if (!link) {
      return def.notFound
        ? def.notFound(ctx)
        : friendlyError(404, 'Not Found', 'This link does not exist or has been removed.', ctx);
    }

    // The registry handler owns the type, but we guard state here:
    if (link.status === 'disabled') {
      return friendlyError(410, 'This link is disabled', 'The owner has disabled this link.', ctx);
    }
    if (link.status === 'archived') {
      return friendlyError(404, 'Not Found', 'This link has been archived.', ctx);
    }
    if (link.expires_at && link.expires_at <= Math.floor(Date.now() / 1000)) {
      return friendlyError(410, 'This link has expired', 'The link you followed has expired.', ctx);
    }

    return handlePublicLink(ctx, def, link);
  };
}

/** Register the registered link-type patterns as routes. */
export function registerPublicRoutes(): void {
  // The registry is populated by registerBuiltinLinkTypes() before this runs.
  for (const def of linkTypeDefinitions()) {
    addRoute('GET', def.path, publicLinkHandler(def));
  }
}

/** Match a public link-type path manually (used for HEAD/OPTIONS). */
export function matchPublicPath(pathname: string): { def: LinkTypeDefinition; id: string } | null {
  for (const def of linkTypeDefinitions()) {
    const params = matchPath(def.path, pathname);
    if (params && params.id) return { def, id: params.id };
  }
  return null;
}

/** Friendly 404 for unmatched public paths. */
export function publicNotFound(_ctx: Ctx): Response {
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
