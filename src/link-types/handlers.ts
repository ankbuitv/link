import { cfg } from '../config';
import type { Ctx } from '../types';
import { redirect } from '../lib/http';
import { escapeHtml, linkErrorPage, type LinkTypeDefinition, type PublicLinkContext, registerLinkType } from './registry';

/**
 * Built-in link types:
 *  - /track/:id  Track Link   (count clicks, then redirect)
 *  - /r/:id      Short Link   (direct redirect, still counted)
 *  - /go/:id     Landing Link (optional landing page with delay)
 *
 * New types (e.g. /file/:id, /invite/:id, /download/:id) can be added by
 * registering one more LinkTypeDefinition — no router changes required.
 */

async function redirectHandler(plc: PublicLinkContext): Promise<Response> {
  const { link } = plc;
  return redirect(link.destination_url, redirectStatus(plc.ctx));
}

function redirectStatus(ctx: Ctx): 301 | 302 {
  return cfg(ctx.env).redirectStatus;
}

/** Landing page template — inline styles only (safe, no third-party content). */
function landingPage(plc: PublicLinkContext, delaySeconds: number): Response {
  const { link, ctx } = plc;
  const appName = cfg(ctx.env).appName;
  const title = link.title || link.slug;
  const description = link.description || `You are being redirected to ${link.destination_url}`;
  const buttonText = link.button_text || 'Continue';
  const metaRefresh = delaySeconds > 0
    ? `<meta http-equiv="refresh" content="${Math.max(0, Math.floor(delaySeconds))};url=${escapeAttr(link.destination_url)}">`
    : '';
  const buttonAuto = delaySeconds > 0 ? `auto-redirecting in <span id="count">${Math.max(0, Math.floor(delaySeconds))}</span>s…` : '';
  const icon = link.icon_url
    ? `<img class="icon" src="${escapeAttr(link.icon_url)}" alt="" width="64" height="64">`
    : '<div class="icon">🔗</div>';
  const image = link.image_url
    ? `<img class="banner" src="${escapeAttr(link.image_url)}" alt="" referrerpolicy="no-referrer">`
    : '';

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${metaRefresh}
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f17;color:#e6edf7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{max-width:480px;width:100%;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:40px 32px;text-align:center}
  .icon{font-size:56px;line-height:1;margin-bottom:16px}
  .icon img{border-radius:14px}
  .banner{width:100%;max-height:220px;object-fit:cover;border-radius:12px;margin-bottom:20px;background:#0b0f17}
  h1{font-size:22px;margin:0 0 10px;color:#f3f6fb;word-break:break-word}
  p.desc{margin:0 0 24px;color:#9aa7ba;font-size:14px;line-height:1.6;word-break:break-word}
  a.btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px;transition:background .15s}
  a.btn:hover{background:#1d4ed8}
  .note{margin-top:14px;color:#6b7a90;font-size:12px}
  .foot{margin-top:28px;color:#4b5563;font-size:12px}
</style></head><body>
<div class="card">
  ${image}
  ${icon}
  <h1>${escapeHtml(title)}</h1>
  <p class="desc">${escapeHtml(description)}</p>
  <a class="btn" href="${escapeAttr(link.destination_url)}" rel="noopener noreferrer nofollow">${escapeHtml(buttonText)}</a>
  ${delaySeconds > 0 ? `<div class="note">${buttonAuto}</div>` : ''}
  <div class="foot">${escapeHtml(appName)}</div>
</div></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    },
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export function registerBuiltinLinkTypes(): void {
  registerLinkType({
    type: 'track',
    path: '/track/:id',
    handle: redirectHandler,
  } satisfies LinkTypeDefinition);

  registerLinkType({
    type: 'short',
    path: '/r/:id',
    handle: redirectHandler,
  } satisfies LinkTypeDefinition);

  registerLinkType({
    type: 'landing',
    path: '/go/:id',
    handle: async (plc) => landingPage(plc, plc.link.delay_seconds || 0),
  } satisfies LinkTypeDefinition);
}

export { linkErrorPage };
