import type { Env } from '../types';
import { getEmailByBrevoMessageId, getEmailById, updateEmail } from './db-emails';
import { getLinkBySlug } from './db-links';

/**
 * Brevo transactional webhook event processing.
 *
 * Payload shape (official Brevo transactional webhook):
 *   { "id": <eventId>, "event": "delivered|opened|click|...",
 *     "email": "...", "date": "...", "ts": <epoch>, "message-id": "...",
 *     "subject": "...", "tag": "...", "link": "https://...", ... }
 *
 * Brevo may send batched webhooks (array of events) when `batched` is
 * enabled. Idempotency: payload_hash (SHA-256 of the raw body) has a UNIQUE
 * index, so replays are ignored automatically.
 */

export type BrevoEventName =
  | 'sent'
  | 'request'
  | 'delivered'
  | 'opened'
  | 'uniqueOpened'
  | 'click'
  | 'softBounce'
  | 'hardBounce'
  | 'blocked'
  | 'spam'
  | 'invalid'
  | 'deferred'
  | 'unsubscribed'
  | 'error';

interface BrevoEventPayload {
  id?: number | string;
  event?: string;
  email?: string;
  date?: string;
  ts?: number;
  ts_epoch?: number;
  'message-id'?: string;
  message_id?: string;
  subject?: string;
  tag?: string;
  link?: string;
  url?: string;
  ip?: string;
  xmailinCustom?: string;
  [key: string]: unknown;
}

/** Map a Brevo event name to the internal email status. */
export function statusForEvent(event: string): string {
  switch (event) {
    case 'sent':
    case 'request':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'opened':
    case 'uniqueOpened':
      return 'opened';
    case 'click':
      return 'clicked';
    case 'softBounce':
      return 'soft_bounce';
    case 'hardBounce':
      return 'hard_bounce';
    case 'blocked':
      return 'blocked';
    case 'spam':
      return 'spam';
    case 'invalid':
      return 'invalid';
    case 'deferred':
      return 'deferred';
    case 'unsubscribed':
      return 'unsubscribed';
    case 'error':
      return 'error';
    default:
      return 'sent';
  }
}

/** Privacy: store only hostname+path of the clicked URL (drop query strings). */
function cleanEventUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.length > 500 ? raw.slice(0, 500) : raw;
  }
}

/** Parse a raw webhook body (single event object or batched array). */
export function parseWebhookBody(raw: string): BrevoEventPayload[] {
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return value as BrevoEventPayload[];
    if (value && typeof value === 'object') return [value as BrevoEventPayload];
    return [];
  } catch {
    return [];
  }
}

export async function processBrevoEvent(env: Env, payload: BrevoEventPayload, payloadHash: string): Promise<void> {
  const eventType = typeof payload.event === 'string' ? payload.event : 'unknown';
  const messageId = (payload['message-id'] || payload.message_id) as string | undefined;
  const timestamp = Number(payload.ts_epoch || payload.ts || Math.floor(Date.now() / 1000));

  // Match the event to an internal email row via the Brevo message id.
  let email = messageId ? await getEmailByBrevoMessageId(env, messageId) : null;

  // Fallback: match by link slug inside a click event.
  let linkId: string | null = null;
  if (!email && (eventType === 'click' || eventType === 'opened')) {
    const url = (payload.link || payload.url) as string | undefined;
    if (url) {
      const m = url.match(/\/(?:track|r|go)\/([A-Za-z0-9_-]+)/);
      if (m) {
        const link = await getLinkBySlug(env, m[1]!);
        if (link) {
          linkId = link.id;
          email = link.email_id ? await getEmailById(env, link.email_id) : null;
        }
      }
    }
  }

  const emailId = email?.id ?? null;

  // Store the event (UNIQUE payload_hash blocks duplicates / replays).
  await env.DB.prepare(
    `INSERT OR IGNORE INTO email_events
       (email_id, event_type, event_timestamp, payload_hash, link_id, url, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      emailId,
      eventType,
      timestamp,
      payloadHash,
      linkId,
      cleanEventUrl(payload.link ?? payload.url),
      (payload.ip as string) ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();

  // Update the email row status (never downgrade a "clicked"/bounce state).
  if (email) {
    const nextStatus = statusForEvent(eventType);
    const rank = (s: string) => {
      const order = ['draft', 'queued', 'sent', 'delivered', 'opened', 'clicked', 'deferred', 'soft_bounce', 'hard_bounce', 'blocked', 'invalid', 'error', 'unsubscribed', 'spam'];
      const idx = order.indexOf(s);
      return idx === -1 ? 0 : idx;
    };
    if (rank(nextStatus) > rank(email.status)) {
      await updateEmail(env, email.id, { status: nextStatus, sent_at: email.sent_at ?? (eventType === 'sent' ? timestamp : null) });
    }
    // Brevo sometimes sends 'click' after the link was already clicked —
    // record the event row regardless (done above).
  }

  // If a click landed on one of our /track links, attribute the link.
  if (linkId && email) {
    await env.DB.prepare(
      'UPDATE link_events SET email_id = ? WHERE link_id = ? AND email_id IS NULL AND id IN (SELECT id FROM link_events WHERE link_id = ? ORDER BY id DESC LIMIT 1)',
    )
      .bind(email.id, linkId, linkId)
      .run();
  }
}

/**
 * Process a whole webhook delivery. Returns counts for observability.
 * A delivery is one HTTP request (single or batched payload).
 */
export async function processWebhookDelivery(env: Env, rawBody: string): Promise<{ received: number; stored: number; duplicates: number; unmatched: number }> {
  const events = parseWebhookBody(rawBody);
  let stored = 0;
  let duplicates = 0;
  let unmatched = 0;
  for (const event of events) {
    const payloadHash = await sha256Hex(JSON.stringify(event));
    const before = await env.DB.prepare('SELECT id FROM email_events WHERE payload_hash = ?').bind(payloadHash).first();
    if (before) {
      duplicates++;
      continue;
    }
    await processBrevoEvent(env, event, payloadHash);
    stored++;
    // Count as unmatched when no email row matched (recorded with NULL email_id).
    const after = await env.DB.prepare('SELECT email_id FROM email_events WHERE payload_hash = ?').bind(payloadHash).first<{ email_id: string | null }>();
    if (after && after.email_id === null) unmatched++;
  }
  return { received: events.length, stored, duplicates, unmatched };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
