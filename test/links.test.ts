import { beforeAll, describe, expect, it } from 'vitest';
import { env, setupAdmin, authedFetch, anonFetch, flushUntil, dbCount } from './helpers';
import { getLinkBySlug } from '../src/lib/db-links';

beforeAll(async () => {
  await setupAdmin();
});

async function createLink(body: Record<string, unknown>, status = 201) {
  const res = await authedFetch('/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as { data: Record<string, any> };
}

describe('link creation', () => {
  it('creates a track link with an auto-generated random slug', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/landing', type: 'track' });
    expect(data.slug).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(data.type).toBe('track');
    expect(data.status).toBe('active');
    expect(data.click_count).toBe(0);
    expect(data.publicUrl).toContain(`/track/${data.slug}`);
  });

  it('creates a link with a custom slug and the correct public route', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/x', type: 'short', slug: 'my-custom-slug' });
    expect(data.slug).toBe('my-custom-slug');
    expect(data.type).toBe('short');
    expect(data.publicUrl).toBe('https://link.ankb.qzz.io/r/my-custom-slug');
  });

  it('rejects a reserved slug', async () => {
    await createLink({ destinationUrl: 'https://example.com/', type: 'track', slug: 'admin' }, 400);
  });

  it('rejects a duplicate slug with 409', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/a', type: 'track', slug: 'unique-slug-1' });
    expect(data.slug).toBe('unique-slug-1');
    await createLink({ destinationUrl: 'https://example.com/b', type: 'track', slug: 'unique-slug-1' }, 409);
  });

  it('rejects dangerous destination schemes', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:x', 'ftp://example.com/x', 'not a url']) {
      await createLink({ destinationUrl: bad, type: 'track' }, 400);
    }
  });

  it('rejects missing/invalid destination', async () => {
    await createLink({ destinationUrl: '', type: 'track' }, 400);
    await createLink({ destinationUrl: 'example.com/no-protocol', type: 'track' }, 400);
  });

  it('accepts a landing link with extras', async () => {
    const { data } = await createLink({
      destinationUrl: 'https://example.com/go',
      type: 'landing',
      title: 'School Update',
      description: 'Read the latest',
      buttonText: 'Read now',
      delaySeconds: 3,
    });
    expect(data.type).toBe('landing');
    expect(data.title).toBe('School Update');
    expect(data.delay_seconds).toBe(3);
    expect(data.publicUrl).toBe(`https://link.ankb.qzz.io/go/${data.slug}`);
  });
});

describe('public redirects', () => {
  it('redirects /track/:slug to the destination (302) and records a click', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/target', type: 'track' });
    const res = await anonFetch(`/track/${data.slug}`, {}, '198.51.100.10');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://example.com/target');

    const counted = await flushUntil(async () => (await getLinkBySlug(env, data.slug))?.click_count === 1);
    expect(counted).toBe(true);
    const events = await flushUntil(async () => (await dbCount('link_events', `WHERE link_id = '${data.id}'`)) >= 1);
    expect(events).toBe(true);
    const daily = await flushUntil(async () => {
      const row = await env.DB.prepare('SELECT clicks FROM link_stats_daily WHERE link_id = ?').bind(data.id).first<{ clicks: number }>();
      return Number(row?.clicks ?? 0) >= 1;
    });
    expect(daily).toBe(true);
  });

  it('redirects /r/:slug directly', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/r-target', type: 'short' });
    const res = await anonFetch(`/r/${data.slug}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://example.com/r-target');
  });

  it('serves a landing page at /go/:slug (no immediate redirect)', async () => {
    const { data } = await createLink({
      destinationUrl: 'https://example.com/landing-target',
      type: 'landing',
      title: 'Welcome <script>alert(1)</script>',
      delaySeconds: 2,
    });
    const res = await anonFetch(`/go/${data.slug}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('http-equiv="refresh" content="2');
    expect(text).toContain('Welcome &lt;script&gt;alert(1)&lt;/script&gt;'); // XSS escaped
    expect(text).not.toContain('<script>alert(1)</script>');
  });

  it('returns a friendly 404 for unknown slugs', async () => {
    const res = await anonFetch('/track/doesnotexist99');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('does not exist');
  });

  it('handles malformed slugs with 404 (no crash)', async () => {
    for (const p of ['/track/', '/track/..%2f..%2fetc', '/track/%00', '/track/../admin', '/track/a%20b']) {
      const res = await anonFetch(p);
      expect([404, 302]).toContain(res.status);
    }
  });

  it('blocks disabled links', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/disabled', type: 'track' });
    const upd = await authedFetch(`/api/links/${data.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(upd.status).toBe(200);
    const res = await anonFetch(`/track/${data.slug}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('disabled');
  });

  it('blocks expired links with a friendly message', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const { data } = await createLink({ destinationUrl: 'https://example.com/expired', type: 'track', expiresAt: past });
    const res = await anonFetch(`/track/${data.slug}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('expired');
  });

  it('tracks unique visitors via salted hash (same visitor counted once)', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/uniques', type: 'track' });
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1';
    await anonFetch(`/track/${data.slug}`, { headers: { 'User-Agent': ua } }, '198.51.100.20');
    await anonFetch(`/track/${data.slug}`, { headers: { 'User-Agent': ua } }, '198.51.100.20');
    await anonFetch(`/track/${data.slug}`, { headers: { 'User-Agent': ua } }, '198.51.100.21');
    const ok = await flushUntil(async () => (await getLinkBySlug(env, data.slug))?.unique_visitors === 2);
    expect(ok).toBe(true);
  });
});

describe('link management API', () => {
  it('lists links with pagination and search', async () => {
    const res = await authedFetch('/api/links?search=target&perPage=10');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: unknown[]; meta: { total: number } } };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('duplicates a link with a fresh slug', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/dup', type: 'track', slug: 'dup-original' });
    const res = await authedFetch(`/api/links/${data.id}/duplicate`, { method: 'POST' });
    expect(res.status).toBe(201);
    const dup = (await res.json()) as { data: { slug: string } };
    expect(dup.data.slug).not.toBe(data.slug);
  });

  it('toggles enable/disable', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/toggle', type: 'track' });
    const res = await authedFetch(`/api/links/${data.id}/toggle`, { method: 'POST' });
    expect(res.status).toBe(200);
    const toggled = (await res.json()) as { data: { status: string } };
    expect(toggled.data.status).toBe('disabled');
  });

  it('deletes a link', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/delete-me', type: 'track' });
    const res = await authedFetch(`/api/links/${data.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await getLinkBySlug(env, data.slug)).toBeNull();
  });
});

describe('analytics API', () => {
  it('returns structured analytics for a link', async () => {
    const { data } = await createLink({ destinationUrl: 'https://example.com/analytics', type: 'track' });
    await anonFetch(`/track/${data.slug}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36' } }, '198.51.100.30');
    await flushUntil(async () => (await dbCount('link_events', `WHERE link_id = '${data.id}'`)) > 0);
    const res = await authedFetch(`/api/links/${data.id}/analytics?range=all`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totals: { clicks: number }; series: unknown[]; devices: { name: string }[]; recent: unknown[] } };
    expect(body.data.totals.clicks).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.data.series)).toBe(true);
    expect(body.data.devices.some((d) => d.name === 'Desktop')).toBe(true);
  });

  it('rejects analytics for a missing link', async () => {
    const res = await authedFetch('/api/links/nonexistent-id/analytics');
    expect(res.status).toBe(404);
  });
});

describe('campaigns API', () => {
  it('creates and lists campaigns with stats', async () => {
    const res = await authedFetch('/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'School Update', description: 'Term 3' }),
    });
    expect(res.status).toBe(201);
    const { data: campaign } = (await res.json()) as { data: { id: string; name: string } };
    expect(campaign.name).toBe('School Update');

    const list = await authedFetch('/api/campaigns');
    const body = (await list.json()) as { data: { items: Array<{ id: string; stats: Record<string, number> }> } };
    const found = body.data.items.find((c) => c.id === campaign.id);
    expect(found).toBeDefined();
    expect(found!.stats).toBeDefined();
  });

  it('links a link to a campaign', async () => {
    const res = await authedFetch('/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Campaign B' }),
    });
    const { data: campaign } = (await res.json()) as { data: { id: string } };
    const link = await createLink({ destinationUrl: 'https://example.com/camp', type: 'track', campaignId: campaign.id });
    expect(link.data.campaign_id).toBe(campaign.id);

    const detail = await authedFetch(`/api/campaigns/${campaign.id}`);
    const body = (await detail.json()) as { data: { links: unknown[] } };
    expect(body.data.links.length).toBe(1);
  });
});
