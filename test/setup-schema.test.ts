import { describe, expect, it } from 'vitest';
import { anonFetch } from './helpers';

/**
 * First-run setup behavior when the D1 schema has NOT been applied yet
 * (migrations pending). Previously this returned a bare 500 INTERNAL_ERROR;
 * now it should render the setup form and return an actionable message.
 *
 * Note: this file intentionally does NOT call `applyMigrations()`, so the
 * in-memory D1 database has no tables.
 */

describe('setup with missing schema', () => {
  it('serves the setup page (HTML form) instead of a 500 JSON error', async () => {
    const res = await anonFetch('/setup');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<form id="f">');
    expect(text).toContain('Create admin account');
    // Must NOT be the generic error envelope.
    expect(text).not.toContain('INTERNAL_ERROR');
  });

  it('POST /setup returns an actionable schema-missing message', async () => {
    const res = await anonFetch('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery-staple' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      success: boolean;
      error?: { code?: string; message?: string };
    };
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('DB_SCHEMA_MISSING');
    expect(body.error?.message).toContain('wrangler d1 migrations apply');
  });
});
