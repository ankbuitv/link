import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { authedFetch, dbCount, setupAdmin } from './helpers';

beforeAll(async () => {
  await setupAdmin();
});

type FetchMock = ReturnType<typeof vi.fn>;

function installBrevoMock(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as FetchMock;
  vi.stubGlobal('fetch', mock);
  return mock;
}

const successSend = (messageIds: string[]) =>
  new Response(JSON.stringify({ messageId: messageIds[0], messageIds }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

function composeBody(overrides: Record<string, unknown> = {}) {
  return {
    to: 'parent@example.com',
    subject: 'School Update — Week 1',
    htmlContent: '<p>Hello, see <a href="https://example.com/notice">the notice</a>.</p>',
    textContent: 'Hello, see the notice: https://example.com/notice',
    senderEmail: 'no-reply@link.ankb.qzz.io',
    senderName: 'Link Center',
    ...overrides,
  };
}

async function post(path: string, body: Record<string, unknown>) {
  return authedFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('compose validation', () => {
  it('rejects invalid recipient emails', async () => {
    const res = await post('/api/mail/drafts', composeBody({ to: 'not-an-email' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not a valid email');
  });

  it('rejects an empty subject', async () => {
    const res = await post('/api/mail/drafts', composeBody({ subject: '  ' }));
    expect(res.status).toBe(400);
  });

  it('rejects contentless emails', async () => {
    const res = await post('/api/mail/drafts', composeBody({ htmlContent: '', textContent: '' }));
    expect(res.status).toBe(400);
  });

  it('rejects scheduling in the past', async () => {
    const res = await post('/api/mail/drafts', composeBody({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() }));
    expect(res.status).toBe(400);
  });
});

describe('drafts & preview', () => {
  it('creates a draft and rewrites URLs into /track links', async () => {
    const res = await post('/api/mail/drafts', composeBody({ trackLinks: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { email: { id: string; status: string }; trackedLinks: Array<{ finalUrl: string }> } };
    expect(body.data.email.status).toBe('draft');
    expect(body.data.trackedLinks.length).toBe(1);
    expect(body.data.trackedLinks[0]!.finalUrl).toMatch(/\/track\/[A-Za-z0-9]{10}$/);

    // The /track link exists and redirects.
    const slug = body.data.trackedLinks[0]!.finalUrl.split('/').pop()!;
    const redirect = await authedFetch(`/track/${slug}`, {}, { withCsrf: false });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('Location')).toBe('https://example.com/notice');
  });

  it('preview returns transformed HTML and creates a draft', async () => {
    const res = await post('/api/mail/preview', composeBody({ trackLinks: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email: { id: string }; transformedHtml: string } };
    expect(body.data.transformedHtml).toContain('/track/');
    expect(body.data.transformedHtml).not.toContain('href="https://example.com/notice"');
  });

  it('does not rewrite when trackLinks is off', async () => {
    const res = await post('/api/mail/drafts', composeBody({ trackLinks: false }));
    const body = (await res.json()) as { data: { trackedLinks: unknown[]; email: { id: string } } };
    expect(body.data.trackedLinks.length).toBe(0);
  });
});

describe('sending', () => {
  it('sends to one recipient via Brevo and stores the message id', async () => {
    installBrevoMock(async (url) => {
      expect(url).toBe('https://api.brevo.com/v3/smtp/email');
      return successSend(['<single-msg@relay.domain.com>']);
    });
    const res = await post('/api/mail/send', composeBody({ trackLinks: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { emails: Array<{ id: string; status: string; brevo_message_id: string | null }>; messageIds: string[]; trackedLinks: unknown[] } };
    expect(body.data.emails.length).toBe(1);
    expect(body.data.emails[0]!.status).toBe('sent');
    expect(body.data.emails[0]!.brevo_message_id).toBe('<single-msg@relay.domain.com>');
    expect(body.data.messageIds).toContain('<single-msg@relay.domain.com>');
    expect(body.data.trackedLinks.length).toBe(1);
  });

  it('sends to multiple recipients and maps messageIds in order', async () => {
    installBrevoMock(async () => successSend(['<m1@relay>', '<m2@relay>']));
    const res = await post('/api/mail/send', composeBody({ to: 'a@example.com\nb@example.com' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { emails: Array<{ recipient: string; brevo_message_id: string | null }> } };
    expect(body.data.emails.length).toBe(2);
    expect(body.data.emails[0]!.brevo_message_id).toBe('<m1@relay>');
    expect(body.data.emails[1]!.brevo_message_id).toBe('<m2@relay>');
  });

  it('marks emails failed and returns 502 when Brevo rejects the send', async () => {
    installBrevoMock(async () =>
      new Response(JSON.stringify({ code: 'invalid_parameter', message: 'sender email not allowed' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post('/api/mail/send', composeBody());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('sender email not allowed');

    const history = await authedFetch('/api/mail/history?status=failed');
    const hb = (await history.json()) as { data: { items: Array<{ error: string | null }> } };
    expect(hb.data.items.length).toBeGreaterThanOrEqual(1);
    expect(hb.data.items[0]!.error).toContain('sender email not allowed');
  });

  it('returns a clear error when Brevo is not configured', async () => {
    // Temporarily unset the key by importing with a custom env is not possible
    // via SELF, so we simulate a network failure instead.
    installBrevoMock(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await post('/api/mail/send', composeBody());
    expect(res.status).toBe(502);
  });

  it('supports scheduled sends (202 from Brevo)', async () => {
    installBrevoMock(async () => new Response(JSON.stringify({ messageId: '<sched@relay>' }), { status: 202 }));
    const future = new Date(Date.now() + 3600_000).toISOString();
    const res = await post('/api/mail/send', composeBody({ scheduledAt: future }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { scheduled: boolean; emails: Array<{ status: string }> } };
    expect(body.data.scheduled).toBe(true);
    expect(body.data.emails[0]!.status).toBe('scheduled');
  });

  it('sends a test email with the test tag', async () => {
    let seenBody = '';
    installBrevoMock(async (url, init) => {
      if (url.includes('/smtp/email')) {
        seenBody = String(init.body);
        return successSend(['<test-msg@relay>']);
      }
      return new Response('{}', { status: 200 });
    });
    const res = await post('/api/mail/test', composeBody());
    expect(res.status).toBe(200);
    expect(seenBody).toContain('"test"');
    expect(seenBody).toContain('app:link-center');
  });
});

describe('history & detail', () => {
  it('lists sent emails with opens/clicks counters', async () => {
    const res = await authedFetch('/api/mail/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ id: string; status: string }>; meta: { total: number } } };
    expect(body.data.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('shows draft emails in history', async () => {
    await post('/api/mail/drafts', composeBody({ subject: 'History Draft Subject' }));
    const res = await authedFetch('/api/mail/history?status=draft');
    const body = (await res.json()) as { data: { items: Array<{ subject: string }> } };
    expect(body.data.items.some((i) => i.subject === 'History Draft Subject')).toBe(true);
  });

  it('deletes drafts only', async () => {
    const d = await post('/api/mail/drafts', composeBody({ subject: 'Delete Me Draft' }));
    const { data } = (await d.json()) as { data: { email: { id: string } } };
    const res = await authedFetch(`/api/mail/${data.email.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const gone = await authedFetch(`/api/mail/${data.email.id}`);
    expect(gone.status).toBe(404);
  });
});

describe('webhooks', () => {
  const SECRET = 'test-webhook-secret';
  const msgId = '<single-msg@relay.domain.com>';

  async function webhook(payload: unknown, extra: { secret?: string | null; header?: string } = {}) {
    const url = new URL('https://example.com/api/webhooks/brevo');
    if (extra.secret !== null && extra.secret !== undefined) url.searchParams.set('secret', extra.secret);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (extra.header) headers['x-webhook-auth-token'] = extra.header;
    return SELF.fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(payload) });
  }

  it('rejects webhooks without the shared secret (spoofing)', async () => {
    const res = await webhook({ id: 1, event: 'delivered', 'message-id': msgId }, { secret: null });
    expect(res.status).toBe(401);
  });

  it('rejects webhooks with a wrong secret', async () => {
    const res = await webhook({ id: 1, event: 'delivered', 'message-id': msgId }, { secret: 'wrong-secret' });
    expect(res.status).toBe(401);
  });

  it('accepts the secret via header and processes events (sent → delivered → opened → click)', async () => {
    installBrevoMock(async () => successSend(['<webhook-chain@relay>']));
    const send = await post('/api/mail/send', composeBody({ trackLinks: true }));
    const sendBody = (await send.json()) as { data: { emails: Array<{ id: string; brevo_message_id: string }>; trackedLinks: Array<{ finalUrl: string }> } };
    const emailId = sendBody.data.emails[0]!.id;
    const thisMsgId = sendBody.data.emails[0]!.brevo_message_id;
    const tracked = sendBody.data.trackedLinks[0]!.finalUrl;

    for (const event of ['sent', 'delivered', 'opened']) {
      const res = await webhook(
        { id: Math.floor(Math.random() * 1e9), event, email: 'parent@example.com', 'message-id': thisMsgId, ts_epoch: Math.floor(Date.now() / 1000) },
        { header: SECRET },
      );
      expect(res.status).toBe(200);
    }
    // click event referencing our tracked link
    const clickRes = await webhook(
      {
        id: Math.floor(Math.random() * 1e9),
        event: 'click',
        email: 'parent@example.com',
        'message-id': thisMsgId,
        link: tracked,
        ts_epoch: Math.floor(Date.now() / 1000),
      },
      { header: SECRET },
    );
    expect(clickRes.status).toBe(200);

    const detail = await authedFetch(`/api/mail/${emailId}`);
    const body = (await detail.json()) as { data: { email: { status: string }; events: Array<{ event_type: string }>; trackedLinks: unknown[] } };
    expect(body.data.email.status).toBe('clicked');
    expect(body.data.events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['sent', 'delivered', 'opened', 'click']));
    expect(body.data.trackedLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores duplicate webhook deliveries (idempotency)', async () => {
    const payload = {
      id: 777001,
      event: 'delivered',
      'message-id': '<dup-msg@relay>',
      ts_epoch: Math.floor(Date.now() / 1000),
    };
    const before = await dbCount('email_events');
    const r1 = await webhook(payload, { secret: SECRET });
    const r2 = await webhook(payload, { secret: SECRET });
    const after = await dbCount('email_events');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { data: { duplicates: number } };
    const b2 = (await r2.json()) as { data: { duplicates: number } };
    expect(b1.data.duplicates).toBe(0);
    expect(b2.data.duplicates).toBe(1);
    expect(after - before).toBe(1);
  });

  it('handles batched webhook payloads (array)', async () => {
    const res = await webhook(
      [
        { id: 1, event: 'sent', 'message-id': '<batch@relay>', ts_epoch: Math.floor(Date.now() / 1000) },
        { id: 2, event: 'hardBounce', 'message-id': '<batch@relay>', ts_epoch: Math.floor(Date.now() / 1000) },
      ],
      { secret: SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { received: number } };
    expect(body.data.received).toBe(2);
  });

  it('records bounce events against the email', async () => {
    installBrevoMock(async () => successSend(['<bounce-msg@relay>']));
    const send = await post('/api/mail/send', composeBody());
    const { data } = (await send.json()) as { data: { emails: Array<{ id: string }> } };
    const emailId = data.emails[0]!.id;

    await webhook(
      { id: 99901, event: 'hardBounce', 'message-id': '<bounce-msg@relay>', ts_epoch: Math.floor(Date.now() / 1000) },
      { secret: SECRET },
    );
    const detail = await authedFetch(`/api/mail/${emailId}`);
    const body = (await detail.json()) as { data: { email: { status: string } } };
    expect(body.data.email.status).toBe('hard_bounce');
  });
});
