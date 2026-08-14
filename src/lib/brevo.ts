import { cfg } from '../config';
import type { Env } from '../types';

/**
 * Server-side Brevo API client.
 *
 * The Brevo API key NEVER leaves the Worker: every request to api.brevo.com
 * is made here with the `api-key` header. The browser only talks to /api/*.
 *
 * References (official, current):
 *  - Send a transactional email: POST https://api.brevo.com/v3/smtp/email
 *    https://developers.brevo.com/reference/send-transac-email
 *  - Account info: GET https://api.brevo.com/v3/account
 *  - Webhooks: GET/POST https://api.brevo.com/v3/webhooks
 */

export interface BrevoRecipient {
  email: string;
  name?: string;
}

export interface BrevoAttachment {
  name?: string;
  url?: string;
  content?: string; // base64
}

export interface SendEmailInput {
  sender: { email: string; name?: string };
  to: BrevoRecipient[];
  subject: string;
  htmlContent?: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
  templateId?: number;
  params?: Record<string, unknown>;
  tags?: string[];
  scheduledAt?: string; // ISO-8601 UTC e.g. 2026-08-14T10:00:00.000Z
  attachments?: BrevoAttachment[];
  headers?: Record<string, string>;
}

export interface BrevoSendResult {
  ok: boolean;
  messageId?: string;
  messageIds?: string[];
  scheduled?: boolean;
  status?: number;
  error?: string;
  errorCode?: string;
}

export class BrevoError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function brevoConfigured(env: Env): boolean {
  return Boolean(env.BREVO_API_KEY);
}

export async function brevoSendTransactionalEmail(
  env: Env,
  input: SendEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BrevoSendResult> {
  if (!env.BREVO_API_KEY) {
    return { ok: false, error: 'Brevo is not configured. Set BREVO_API_KEY (server secret).', errorCode: 'NOT_CONFIGURED' };
  }
  const base = cfg(env).brevoBaseUrl;
  const body: Record<string, unknown> = {
    sender: input.sender,
    to: input.to,
    subject: input.subject,
  };
  if (input.htmlContent) body.htmlContent = input.htmlContent;
  if (input.textContent) body.textContent = input.textContent;
  if (input.replyTo) body.replyTo = input.replyTo;
  if (input.templateId !== undefined) body.templateId = input.templateId;
  if (input.params && Object.keys(input.params).length > 0) body.params = input.params;
  if (input.tags && input.tags.length > 0) body.tags = input.tags;
  if (input.scheduledAt) body.scheduledAt = input.scheduledAt;
  if (input.attachments && input.attachments.length > 0) body.attachment = input.attachments;
  if (input.headers && Object.keys(input.headers).length > 0) body.headers = input.headers;

  try {
    const res = await fetchImpl(`${base}/smtp/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'api-key': env.BREVO_API_KEY,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON error body */
    }
    if (res.ok) {
      const messageIds = Array.isArray(data.messageIds) ? (data.messageIds as string[]) : undefined;
      return {
        ok: true,
        messageId: typeof data.messageId === 'string' ? data.messageId : undefined,
        messageIds,
        scheduled: res.status === 202,
        status: res.status,
      };
    }
    return {
      ok: false,
      status: res.status,
      error: (data.message as string) || `Brevo responded with HTTP ${res.status}.`,
      errorCode: (data.code as string) || 'BREVO_ERROR',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error while contacting Brevo.',
      errorCode: 'BREVO_NETWORK',
    };
  }
}

/** GET /v3/account — used by Settings to show connection status. */
export async function brevoAccountStatus(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ connected: boolean; email?: string; companyName?: string; plan?: string; error?: string }> {
  if (!env.BREVO_API_KEY) return { connected: false, error: 'API key not configured' };
  const base = cfg(env).brevoBaseUrl;
  try {
    const res = await fetchImpl(`${base}/account`, {
      headers: { accept: 'application/json', 'api-key': env.BREVO_API_KEY },
    });
    if (!res.ok) return { connected: false, error: `Brevo account check failed (HTTP ${res.status})` };
    const data = (await res.json()) as {
      email?: string;
      companyName?: string;
      plan?: Array<{ type?: string }>;
    };
    return {
      connected: true,
      email: data.email,
      companyName: data.companyName,
      plan: data.plan?.[0]?.type,
    };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/** GET /v3/webhooks — shows configured webhooks in Settings. */
export async function brevoListWebhooks(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ webhooks: Array<{ id: number; url: string; type: string; events: string[] }>; error?: string }> {
  if (!env.BREVO_API_KEY) return { webhooks: [], error: 'API key not configured' };
  const base = cfg(env).brevoBaseUrl;
  try {
    const res = await fetchImpl(`${base}/webhooks`, {
      headers: { accept: 'application/json', 'api-key': env.BREVO_API_KEY },
    });
    if (!res.ok) return { webhooks: [], error: `Failed to list webhooks (HTTP ${res.status})` };
    const data = (await res.json()) as {
      webhooks?: Array<{ id: number; url: string; type: string; events: string[] }>;
    };
    return { webhooks: data.webhooks || [] };
  } catch (err) {
    return { webhooks: [], error: err instanceof Error ? err.message : 'Network error' };
  }
}

/** Mask an API key for display — only the last 4 chars are shown. */
export function maskBrevoKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `••••••••${key.slice(-4)}`;
}
