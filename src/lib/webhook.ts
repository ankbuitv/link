import type { Env } from '../types';
import { constantTimeEqualString } from './session';

/**
 * Brevo webhook verification.
 *
 * Brevo does not sign webhook payloads (no HMAC header) — its official
 * authentication options are Basic or Token (see
 * https://help.brevo.com/hc/en-us/articles/27824932835474 and the
 * `auth` object of POST /v3/webhooks). We therefore require a shared secret
 * (`BREVO_WEBHOOK_SECRET`) that Brevo must present in one of these forms:
 *
 *   1. `?secret=...` or `?token=...` query parameter (recommended: embed it
 *      in the webhook URL when creating the webhook),
 *   2. `X-Webhook-Auth-Token: <secret>` header (Brevo custom headers),
 *   3. `Authorization: Bearer <secret>` (Brevo "token" auth type),
 *   4. `Authorization: Basic <base64(anything:secret)>` (Brevo "basic" auth).
 *
 * When the secret is not configured at all, the endpoint refuses to run
 * (503) rather than silently accepting unauthenticated payloads.
 */

export function verifyBrevoWebhook(request: Request, env: Env): boolean {
  const secret = env.BREVO_WEBHOOK_SECRET;
  if (!secret) return false;

  // 1. Query parameter.
  const url = new URL(request.url);
  const q = url.searchParams.get('secret') ?? url.searchParams.get('token');
  if (q && constantTimeEqualString(q, secret)) return true;

  // 2. Custom header.
  const headerToken = request.headers.get('X-Webhook-Auth-Token');
  if (headerToken && constantTimeEqualString(headerToken, secret)) return true;

  // 3. Bearer token.
  const auth = request.headers.get('Authorization');
  if (auth) {
    if (auth.startsWith('Bearer ') && constantTimeEqualString(auth.slice(7).trim(), secret)) return true;
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = atob(auth.slice(6).trim());
        const colon = decoded.indexOf(':');
        if (colon !== -1) {
          const password = decoded.slice(colon + 1);
          if (constantTimeEqualString(password, secret)) return true;
        }
      } catch {
        /* malformed base64 */
      }
    }
  }
  return false;
}
