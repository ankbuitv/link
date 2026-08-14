import type { Ctx } from '../types';
import { ok, fail } from '../lib/http';
import { processWebhookDelivery } from '../lib/events';
import { verifyBrevoWebhook } from '../lib/webhook';
import { addRoute } from './router';

/**
 * POST /api/webhooks/brevo
 *
 * Brevo transactional webhook endpoint. Verification:
 *  - the shared BREVO_WEBHOOK_SECRET must be present (query param, custom
 *    header, Bearer or Basic auth) — see src/lib/webhook.ts,
 *  - replays/duplicates are ignored via the UNIQUE payload_hash index.
 *
 * Configure in Brevo:  Transactional emails → Webhook
 *   URL: https://link.ankb.qzz.io/api/webhooks/brevo?secret=<BREVO_WEBHOOK_SECRET>
 *   Events: sent, delivered, opened, click, softBounce, hardBounce, blocked,
 *           spam, invalid, deferred, unsubscribed (+ error)
 */
function registerWebhookRoutes(): void {
  addRoute('POST', '/api/webhooks/brevo', async (ctx: Ctx) => {
    if (!verifyBrevoWebhook(ctx.request, ctx.env)) {
      return fail('UNAUTHORIZED', 'Invalid webhook secret.', 401);
    }
    const raw = await ctx.request.text();
    if (!raw) return fail('INVALID_REQUEST', 'Empty webhook body.', 400);
    if (raw.length > 2_000_000) return fail('INVALID_REQUEST', 'Webhook body too large.', 413);

    const counts = await processWebhookDelivery(ctx.env, raw);
    return ok({
      received: counts.received,
      stored: counts.stored,
      duplicates: counts.duplicates,
      unmatched: counts.unmatched,
    });
  });

  addRoute('GET', '/api/webhooks/brevo', async (_ctx: Ctx) => {
    // Brevo does not GET this endpoint; used for health checks only.
    return ok({ ok: true, name: 'brevo-webhook' });
  });
}

export { registerWebhookRoutes };
