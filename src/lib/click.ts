import { cfg } from '../config';
import type { Ctx, Env } from '../types';
import { cleanReferrer, classifyUserAgent } from './ua';

/**
 * Click recording pipeline.
 *
 * Sync (fast path — before the redirect is returned):
 *   UPDATE links SET click_count = click_count + 1
 *
 * Async (ctx.waitUntil, after the response has been sent):
 *   1. KV dedupe for the unique-visitor counter (per link per day per hash),
 *   2. insert one row into link_events,
 *   3. upsert the daily aggregate row.
 *
 * Privacy: no raw IP is stored. The visitor fingerprint is a salted SHA-256
 * of (IP + user agent + day) using CLICK_SALT, kept only to deduplicate
 * unique visitors; the derived categories (country/device/browser/os/referrer
 * hostname) are coarse and non-identifying.
 */

export interface ClickInfo {
  country: string | null;
  device: string;
  browser: string;
  os: string;
  referrer: string | null;
  visitorHash: string;
}

export async function buildClickInfo(request: Request, env: Env): Promise<ClickInfo> {
  const ua = request.headers.get('User-Agent');
  const uaInfo = classifyUserAgent(ua);
  const country = request.headers.get('CF-IPCountry');
  const referrer = cleanReferrer(request.headers.get('Referer'));
  const salt = env.CLICK_SALT || 'link-center-default-salt';
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0';
  const day = new Date().toISOString().slice(0, 10);
  const visitorHash = (await sha256Hex(`${salt}|${ip}|${ua}|${day}`)).slice(0, 32);
  return { country, device: uaInfo.device, browser: uaInfo.browser, os: uaInfo.os, referrer, visitorHash };
}

/** Fast synchronous counter update. */
export async function incrementClickCounter(env: Env, linkId: string): Promise<void> {
  await env.DB.prepare('UPDATE links SET click_count = click_count + 1, updated_at = unixepoch() WHERE id = ?')
    .bind(linkId)
    .run();
}

/** Async analytics writes (call inside ctx.waitUntil). */
export async function recordClickAsync(ctx: Ctx, linkId: string, info: ClickInfo, emailId: string | null): Promise<void> {
  const { env } = ctx;
  const now = Math.floor(Date.now() / 1000);
  const day = new Date().toISOString().slice(0, 10);

  let isNewVisitor = false;
  if (env.KV) {
    const kvKey = `uniq:${linkId}:${day}:${info.visitorHash}`;
    try {
      const existing = await env.KV.get(kvKey);
      if (existing === null) {
        await env.KV.put(kvKey, '1', { expirationTtl: 60 * 60 * 30 }); // 30h
        isNewVisitor = true;
      }
    } catch {
      isNewVisitor = true; // KV hiccup — count conservatively as unique
    }
  }

  // Insert event row.
  await env.DB.prepare(
    `INSERT INTO link_events (link_id, timestamp, country, device, browser, os, referrer, visitor_hash, email_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(linkId, now, info.country, info.device, info.browser, info.os, info.referrer, info.visitorHash, emailId)
    .run();

  // Update unique counter if KV says this is a new visitor.
  if (isNewVisitor) {
    await env.DB.prepare('UPDATE links SET unique_visitors = unique_visitors + 1 WHERE id = ?').bind(linkId).run();
  }

  // Upsert daily aggregate.
  const agg = await env.DB.prepare('SELECT clicks, uniques FROM link_stats_daily WHERE link_id = ? AND day = ?')
    .bind(linkId, day)
    .first<{ clicks: number; uniques: number }>();
  if (agg) {
    await env.DB.prepare(
      'UPDATE link_stats_daily SET clicks = clicks + 1, uniques = uniques + ? WHERE link_id = ? AND day = ?',
    )
      .bind(isNewVisitor ? 1 : 0, linkId, day)
      .run();
  } else {
    await env.DB.prepare('INSERT INTO link_stats_daily (link_id, day, clicks, uniques) VALUES (?, ?, 1, ?)')
      .bind(linkId, day, isNewVisitor ? 1 : 0)
      .run();
  }

  // Retention: prune old events occasionally (≈1% of clicks) so the cleanup
  // never adds meaningful load to the click path.
  if (Math.random() < 0.01) {
    void pruneOldEvents(env);
  }
}

async function pruneOldEvents(env: Env): Promise<void> {
  const days = cfg(env).analyticsRetentionDays;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  await env.DB.prepare('DELETE FROM link_events WHERE timestamp < ? AND id NOT IN (SELECT MAX(id) FROM link_events GROUP BY link_id)')
    .bind(cutoff)
    .run();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
