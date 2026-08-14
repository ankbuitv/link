import type { Ctx, LinkRow } from '../types';
import { buildClickInfo, incrementClickCounter, recordClickAsync } from '../lib/click';
import { html } from '../lib/http';

/**
 * Extensible link-type engine.
 *
 * A link type is a (path, handler) pair. Public requests are matched against
 * the registry's path patterns first — adding a new link type is as simple as
 * registering one more entry (e.g. `/file/:id`, `/invite/:id`, ...) without
 * touching the router.
 */

export interface PublicLinkContext {
  ctx: Ctx;
  link: LinkRow;
  /** Click details already computed (privacy-conscious). */
  click: Awaited<ReturnType<typeof buildClickInfo>>;
}

export interface LinkTypeDefinition {
  type: string;
  /** Path pattern, e.g. '/track/:id' (leading slash, ':id' placeholder). */
  path: string;
  /** Handle a validated, active, non-expired link hit. */
  handle: (plc: PublicLinkContext) => Promise<Response>;
  /** Friendly page shown when the link is not found (default 404). */
  notFound?: (ctx: Ctx) => Response;
}

const registry = new Map<string, LinkTypeDefinition>();

export function registerLinkType(def: LinkTypeDefinition): void {
  registry.set(def.path, def);
}

export function getLinkType(path: string): LinkTypeDefinition | undefined {
  return registry.get(path);
}

export function linkTypeDefinitions(): LinkTypeDefinition[] {
  return [...registry.values()];
}

/** Match a request pathname against a pattern with ':id' style params. */
export function matchPath(pattern: string, pathname: string): { [key: string]: string } | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: { [key: string]: string } = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(s[i]!);
    } else if (part !== s[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Shared pipeline for a public link hit:
 *  1. lookup link (cached),
 *  2. validate status/expiry,
 *  3. increment the click counter synchronously,
 *  4. schedule privacy-conscious analytics writes,
 *  5. delegate to the type handler (redirect / landing).
 */
export async function handlePublicLink(ctx: Ctx, def: LinkTypeDefinition, link: LinkRow): Promise<Response> {
  const click = await buildClickInfo(ctx.request, ctx.env);

  // Fast synchronous counter bump.
  try {
    await incrementClickCounter(ctx.env, link.id);
  } catch {
    // Counter failure must not break the redirect.
  }

  // Async analytics (event row, unique visitor, daily aggregate, retention).
  ctx.ctx.waitUntil(recordClickAsync(ctx, link.id, click, link.email_id).catch(() => {}));

  return def.handle({ ctx, link, click });
}

/** Standard friendly error page for a public link. */
export function linkErrorPage(title: string, message: string, appName: string): Response {
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f17;color:#e6edf7;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{max-width:420px;width:90%;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:36px 32px;text-align:center}
  .code{font-size:52px;line-height:1;margin-bottom:12px}
  h1{font-size:20px;margin:0 0 8px;color:#f3f6fb}
  p{margin:0;color:#9aa7ba;font-size:14px;line-height:1.5}
  a{display:inline-block;margin-top:20px;color:#60a5fa;text-decoration:none;font-size:14px}
</style></head><body>
<div class="card"><div class="code">🔗</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<a href="/">Go to ${escapeHtml(appName)}</a>
</div></body></html>`,
    { status: title === 'Not Found' ? 404 : 410 },
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
