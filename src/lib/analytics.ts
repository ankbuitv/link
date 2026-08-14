import type { CategoryCount, Env, LinkAnalytics } from '../types';
import { getLinkById } from './db-links';

/**
 * Analytics aggregation. Time series come from the pre-aggregated
 * link_stats_daily table; breakdowns (country/device/browser/os/referrer)
 * come from link_events with GROUP BY.
 */

export type RangeKey = '24h' | '7d' | '30d' | 'all' | 'custom';

export function resolveRange(range: string, fromInput?: string, toInput?: string): { from: number; to: number; range: RangeKey } {
  const now = Date.now();
  let toTs = toInput ? Date.parse(toInput) : now;
  let fromTs: number;
  let key: RangeKey = 'all';
  if (range === '24h') {
    fromTs = now - 24 * 3600 * 1000;
    key = '24h';
  } else if (range === '7d') {
    fromTs = now - 7 * 86400 * 1000;
    key = '7d';
  } else if (range === '30d') {
    fromTs = now - 30 * 86400 * 1000;
    key = '30d';
  } else if (range === 'custom' && fromInput) {
    fromTs = Date.parse(fromInput);
    key = 'custom';
  } else {
    fromTs = 0;
    key = 'all';
  }
  if (!Number.isFinite(fromTs)) fromTs = 0;
  if (!Number.isFinite(toTs)) toTs = now;
  return { from: Math.floor(fromTs / 1000), to: Math.floor(toTs / 1000), range: key };
}

function dayLabel(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export async function getLinkAnalytics(env: Env, linkId: string, rangeInput: string, fromInput?: string, toInput?: string): Promise<LinkAnalytics | null> {
  const link = await getLinkById(env, linkId);
  if (!link) return null;
  const { from, to, range } = resolveRange(rangeInput, fromInput, toInput);

  // Time series from the daily aggregate table.
  const seriesRows = await env.DB.prepare(
    `SELECT day, SUM(clicks) AS clicks, SUM(uniques) AS uniques
     FROM link_stats_daily
     WHERE link_id = ? AND day >= ? AND day <= ?
     GROUP BY day ORDER BY day ASC`,
  )
    .bind(linkId, dayLabel(from), dayLabel(to))
    .all<{ day: string; clicks: number; uniques: number }>();

  const series = seriesRows.results.map((r) => ({
    date: r.day,
    label: r.day,
    clicks: Number(r.clicks),
    uniques: Number(r.uniques),
  }));

  // Fill gaps for short ranges.
  if (range === '24h' || range === '7d') {
    const fill = new Map(series.map((s) => [s.date, s]));
    const days = Math.min(range === '24h' ? 2 : 7, Math.ceil((to - from) / 86400) + 1);
    const out: typeof series = [];
    for (let i = days - 1; i >= 0; i--) {
      const ts = to - i * 86400;
      const d = dayLabel(ts);
      out.push(fill.get(d) ?? { date: d, label: d, clicks: 0, uniques: 0 });
    }
    series.splice(0, series.length, ...out);
  }

  // Hourly distribution (0-23) from raw events.
  const hourlyRows = await env.DB.prepare(
    `SELECT CAST(strftime('%H', timestamp, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS n
     FROM link_events
     WHERE link_id = ? AND timestamp >= ? AND timestamp <= ?
     GROUP BY hour ORDER BY hour ASC`,
  )
    .bind(linkId, from, to)
    .all<{ hour: number; n: number }>();
  const hourlyMap = new Map(hourlyRows.results.map((r) => [Number(r.hour), Number(r.n)]));
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${String(h).padStart(2, '0')}:00`,
    clicks: hourlyMap.get(h) ?? 0,
  }));

  // Breakdowns.
  const breakdown = async (col: string, limit = 10): Promise<CategoryCount[]> => {
    const rows = await env.DB.prepare(
      `SELECT ${col} AS name, COUNT(*) AS count FROM link_events
       WHERE link_id = ? AND timestamp >= ? AND timestamp <= ? AND ${col} IS NOT NULL
       GROUP BY ${col} ORDER BY count DESC LIMIT ?`,
    )
      .bind(linkId, from, to, limit)
      .all<{ name: string; count: number }>();
    return rows.results.map((r) => ({ name: String(r.name), count: Number(r.count) }));
  };

  // Totals within range.
  const totalsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniques FROM link_events
     WHERE link_id = ? AND timestamp >= ? AND timestamp <= ?`,
  )
    .bind(linkId, from, to)
    .first<{ clicks: number; uniques: number }>();

  // Recent events (privacy: categories only, no IP/UA).
  const recentRows = await env.DB.prepare(
    `SELECT timestamp, country, device, browser, os, referrer FROM link_events
     WHERE link_id = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY id DESC LIMIT 25`,
  )
    .bind(linkId, from, to)
    .all<{ timestamp: number; country: string | null; device: string | null; browser: string | null; os: string | null; referrer: string | null }>();

  const recent = recentRows.results.map((r) => ({
    timestamp: Number(r.timestamp),
    country: r.country ?? null,
    device: r.device ?? null,
    browser: r.browser ?? null,
    os: r.os ?? null,
    referrer: r.referrer ?? null,
  }));

  return {
    link: {
      id: link.id,
      slug: link.slug,
      type: link.type,
      destination_url: link.destination_url,
      title: link.title,
      click_count: link.click_count,
      unique_visitors: link.unique_visitors,
      status: link.status,
    },
    range,
    from,
    to,
    totals: {
      clicks: Number(totalsRow?.clicks ?? 0),
      uniques: Number(totalsRow?.uniques ?? 0),
    },
    series,
    hourly,
    countries: await breakdown('country'),
    devices: await breakdown('device'),
    browsers: await breakdown('browser'),
    os: await breakdown('os'),
    referrers: await breakdown('referrer', 8),
    recent,
  };
}

/** Global analytics across all links. */
export async function getGlobalAnalytics(env: Env, rangeInput: string, from?: string, to?: string) {
  const { from: fromTs, to: toTs } = resolveRange(rangeInput, from, to);
  const totalsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniques FROM link_events
     WHERE timestamp >= ? AND timestamp <= ?`,
  )
    .bind(fromTs, toTs)
    .first<{ clicks: number; uniques: number }>();

  const seriesRows = await env.DB.prepare(
    `SELECT day, SUM(clicks) AS clicks, SUM(uniques) AS uniques FROM link_stats_daily
     WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day ASC`,
  )
    .bind(dayLabel(fromTs), dayLabel(toTs))
    .all<{ day: string; clicks: number; uniques: number }>();

  const topLinks = await env.DB.prepare(
    `SELECT l.id, l.slug, l.type, l.title, l.destination_url, l.click_count, l.unique_visitors,
            c.name AS campaign_name
     FROM links l LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.status = 'active'
     ORDER BY l.click_count DESC LIMIT 10`,
  )
    .all<Record<string, unknown>>();

  const breakdown = async (col: string, limit = 8) => {
    const rows = await env.DB.prepare(
      `SELECT ${col} AS name, COUNT(*) AS count FROM link_events
       WHERE timestamp >= ? AND timestamp <= ? AND ${col} IS NOT NULL
       GROUP BY ${col} ORDER BY count DESC LIMIT ?`,
    )
      .bind(fromTs, toTs, limit)
      .all<{ name: string; count: number }>();
    return rows.results.map((r) => ({ name: String(r.name), count: Number(r.count) }));
  };

  const emailRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN status IN ('opened','clicked') THEN 1 ELSE 0 END) AS opened,
            SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) AS clicked,
            SUM(CASE WHEN status IN ('hard_bounce','soft_bounce','blocked','invalid') THEN 1 ELSE 0 END) AS bounced
     FROM emails`,
  )
    .first<{ total: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number }>();

  return {
    totals: {
      clicks: Number(totalsRow?.clicks ?? 0),
      uniques: Number(totalsRow?.uniques ?? 0),
    },
    series: seriesRows.results.map((r) => ({ date: r.day, label: r.day, clicks: Number(r.clicks), uniques: Number(r.uniques) })),
    topLinks: topLinks.results.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      type: String(r.type),
      title: r.title ? String(r.title) : null,
      destination_url: String(r.destination_url),
      click_count: Number(r.click_count),
      unique_visitors: Number(r.unique_visitors),
      campaign_name: r.campaign_name ? String(r.campaign_name) : null,
    })),
    countries: await breakdown('country'),
    devices: await breakdown('device'),
    browsers: await breakdown('browser'),
    os: await breakdown('os'),
    email: {
      total: Number(emailRow?.total ?? 0),
      sent: Number(emailRow?.sent ?? 0),
      delivered: Number(emailRow?.delivered ?? 0),
      opened: Number(emailRow?.opened ?? 0),
      clicked: Number(emailRow?.clicked ?? 0),
      bounced: Number(emailRow?.bounced ?? 0),
    },
  };
}

/** Overview card data for the dashboard home. */
export async function getOverview(env: Env): Promise<Record<string, unknown>> {
  const linksRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(click_count), 0) AS clicks,
            COALESCE(SUM(unique_visitors), 0) AS uniques
     FROM links`,
  )
    .first<{ total: number; active: number; clicks: number; uniques: number }>();

  const emailRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN status IN ('opened','clicked') THEN 1 ELSE 0 END) AS opened,
            SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) AS clicked,
            SUM(CASE WHEN status IN ('hard_bounce','soft_bounce','blocked','invalid') THEN 1 ELSE 0 END) AS bounced
     FROM emails`,
  )
    .first<{ total: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number }>();

  const sent = Number(emailRow?.sent ?? 0);
  const delivered = Number(emailRow?.delivered ?? 0);
  const opened = Number(emailRow?.opened ?? 0);
  const clicked = Number(emailRow?.clicked ?? 0);

  const recentLinks = await env.DB.prepare(
    `SELECT l.id, l.slug, l.type, l.title, l.destination_url, l.click_count, l.status, l.created_at
     FROM links l ORDER BY l.created_at DESC LIMIT 5`,
  )
    .all<Record<string, unknown>>();

  const recentEmails = await env.DB.prepare(
    `SELECT id, recipient, subject, status, created_at, campaign_id FROM emails ORDER BY created_at DESC LIMIT 5`,
  )
    .all<Record<string, unknown>>();

  const topLinks = await env.DB.prepare(
    `SELECT slug, title, click_count FROM links WHERE status = 'active' ORDER BY click_count DESC LIMIT 5`,
  )
    .all<Record<string, unknown>>();

  return {
    links: {
      total: Number(linksRow?.total ?? 0),
      active: Number(linksRow?.active ?? 0),
      clicks: Number(linksRow?.clicks ?? 0),
      uniques: Number(linksRow?.uniques ?? 0),
    },
    email: {
      total: Number(emailRow?.total ?? 0),
      sent,
      delivered,
      opened,
      clicked,
      bounced: Number(emailRow?.bounced ?? 0),
      deliveryRate: sent > 0 ? Math.round((delivered / sent) * 100) / 100 : 0,
      openRate: delivered > 0 ? Math.round((opened / delivered) * 100) / 100 : 0,
      clickRate: delivered > 0 ? Math.round((clicked / delivered) * 100) / 100 : 0,
    },
    recentLinks: recentLinks.results.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      type: String(r.type),
      title: r.title ? String(r.title) : null,
      destination_url: String(r.destination_url),
      click_count: Number(r.click_count),
      status: String(r.status),
      created_at: Number(r.created_at),
    })),
    recentEmails: recentEmails.results.map((r) => ({
      id: String(r.id),
      recipient: String(r.recipient),
      subject: String(r.subject),
      status: String(r.status),
      campaign_id: r.campaign_id ? String(r.campaign_id) : null,
      created_at: Number(r.created_at),
    })),
    topLinks: topLinks.results.map((r) => ({
      slug: String(r.slug),
      title: r.title ? String(r.title) : null,
      click_count: Number(r.click_count),
    })),
  };
}
