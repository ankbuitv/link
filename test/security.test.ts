import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authedFetch, anonFetch, env, setupAdmin } from './helpers';

beforeAll(async () => {
  await setupAdmin();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authentication', () => {
  it('rejects unauthenticated API requests', async () => {
    for (const path of ['/api/links', '/api/overview', '/api/settings', '/api/mail/history', '/api/campaigns']) {
      const res = await anonFetch(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('rejects unauthenticated mutations with 401', async () => {
    const res = await anonFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'https://example.com/x', type: 'track' }),
    });
    expect(res.status).toBe(401);
  });

  it('serves the dashboard shell without leaking data', async () => {
    const res = await anonFetch('/dashboard');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<div id="app"');
    expect(text).not.toContain('BREVO_API_KEY');
  });

  it('hashes passwords with PBKDF2 (no plaintext)', async () => {
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE username = ?').bind('admin').first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$/);
    expect(row?.password_hash).not.toContain('correct-horse');
  });

  it('sets HttpOnly and SameSite cookies on login', async () => {
    const res = await anonFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.50' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery-staple' }),
    });
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
  });

  it('rate limits login attempts per IP', async () => {
    const ip = '203.0.113.200';
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await anonFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      });
      if (res.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  });
});

describe('CSRF & origin protection', () => {
  it('rejects mutations without the CSRF token', async () => {
    const res = await authedFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'https://example.com/csrf', type: 'track' }),
    }, { withCsrf: false });
    expect(res.status).toBe(403);
  });

  it('rejects mutations with a wrong CSRF token', async () => {
    const res = await authedFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'forged-token' },
      body: JSON.stringify({ destinationUrl: 'https://example.com/csrf2', type: 'track' }),
    }, { withCsrf: false });
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin mutations', async () => {
    const res = await authedFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'https://example.com/origin', type: 'track' }),
    }, { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('accepts same-origin mutations with a valid CSRF token', async () => {
    const res = await authedFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'https://example.com/ok', type: 'track' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('input handling', () => {
  it('rejects malformed JSON with 400', async () => {
    const res = await authedFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('escapes stored XSS payloads in API output and pages', async () => {
    const res = await authedFetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        destinationUrl: 'https://example.com/xss',
        type: 'landing',
        title: '<img src=x onerror=alert(1)>',
        description: '<script>alert(1)</script>',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { slug: string } };
    const page = await anonFetch(`/go/${body.data.slug}`);
    const html = await page.text();
    // Escaped: no executable tags/attributes remain in the rendered page.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('returns consistent error envelopes', async () => {
    const res = await authedFetch('/api/links/does-not-exist-xyz');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('does not leak stack traces on server errors', async () => {
    // Trigger an internal error by hitting a route with a bad param shape.
    const res = await anonFetch('/api/links/..%2F..%2F..%2Fetc%2Fpasswd/analytics');
    const text = await res.text();
    expect(text).not.toContain('at ');
    expect(text).not.toContain('stack');
  });
});

describe('security headers & misc', () => {
  it('applies security headers to API responses', async () => {
    const res = await anonFetch('/api/auth/me');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age');
  });

  it('applies CSP to the dashboard shell', async () => {
    const res = await anonFetch('/dashboard');
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('serves static assets and the dedicated create-link route', async () => {
    const asset = await anonFetch('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Content-Type') || '').toContain('javascript');
    expect(await asset.text()).toContain('Create a new link');

    const page = await anonFetch('/dashboard/links/new');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="app"');
  });

  it('robots.txt disallows crawling', async () => {
    const res = await anonFetch('/robots.txt');
    expect(await res.text()).toContain('Disallow: /');
  });

  it('public 404 pages are friendly HTML (not JSON stack)', async () => {
    const res = await anonFetch('/track/zzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type') || '').toContain('text/html');
  });
});
