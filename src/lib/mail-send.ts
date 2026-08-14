import type { Ctx, EmailRow, UserRow } from '../types';
import { brevoSendTransactionalEmail } from './brevo';
import {
  getEmailById,
  getEmailByBrevoMessageId,
  insertEmail,
  updateEmail,
} from './db-emails';
import { ipKey, kvCheck } from './ratelimit';
import { applyMapping, extractUrls, persistTrackedLinks, planUrlMappings, type UrlMapping } from './link-rewrite';
import { buildSettings } from './settings';
import { INVALID_REQUEST, fail } from './http';
import { isValidEmail, parseRecipients, toBool } from './validate';

/**
 * Email compose → send orchestration.
 *
 * All Brevo calls happen here, server-side, with the API key never leaving
 * the Worker.
 */

export interface ComposeBody {
  to?: unknown;
  subject?: unknown;
  htmlContent?: unknown;
  textContent?: unknown;
  senderEmail?: unknown;
  senderName?: unknown;
  replyTo?: unknown;
  campaignId?: unknown;
  trackLinks?: unknown;
  scheduledAt?: unknown;
  tags?: unknown;
  templateId?: unknown;
  params?: unknown;
  draftId?: unknown;
  draft?: unknown;
}

export interface ValidateResult {
  ok: boolean;
  error?: Response;
  recipients: string[];
  subject: string;
  html: string;
  text: string;
  senderEmail: string;
  senderName: string;
  replyTo: string | null;
  campaignId: string | null;
  trackLinks: boolean;
  scheduledAt: string | null;
  tags: string[];
  templateId: number | null;
  params: Record<string, unknown>;
  draftId: string | null;
  urls: string[];
}

async function validateComposeInput(ctx: Ctx, body: ComposeBody): Promise<ValidateResult> {
  const settings = await buildSettings(ctx.env);

  const { emails, errors } = parseRecipients(body.to);
  if (errors.length > 0) {
    return { ok: false, error: INVALID_REQUEST(errors.join(' ')), recipients: [], subject: '', html: '', text: '', senderEmail: '', senderName: '', replyTo: null, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
  }
  if (emails.length === 0) {
    return { ok: false, error: INVALID_REQUEST('At least one recipient is required.'), recipients: [], subject: '', html: '', text: '', senderEmail: '', senderName: '', replyTo: null, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
  }

  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!subject || subject.length > 500) {
    return { ok: false, error: INVALID_REQUEST('Subject is required (max 500 characters).'), recipients: emails, subject, html: '', text: '', senderEmail: '', senderName: '', replyTo: null, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
  }

  const html = typeof body.htmlContent === 'string' ? body.htmlContent : '';
  const text = typeof body.textContent === 'string' ? body.textContent : '';
  if (!html && !text && body.templateId === undefined) {
    return { ok: false, error: INVALID_REQUEST('Provide HTML content, plain-text content, or a Brevo templateId.'), recipients: emails, subject, html: '', text, senderEmail: '', senderName: '', replyTo: null, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
  }

  const senderEmail = typeof body.senderEmail === 'string' && body.senderEmail.trim()
    ? body.senderEmail.trim()
    : settings.brevoSenderEmail;
  if (!isValidEmail(senderEmail)) {
    return { ok: false, error: INVALID_REQUEST('A valid sender email is required (configure it in Settings or pass senderEmail).'), recipients: emails, subject, html, text, senderEmail, senderName: '', replyTo: null, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
  }

  const senderName = typeof body.senderName === 'string' && body.senderName.trim()
    ? body.senderName.trim().slice(0, 70)
    : settings.brevoSenderName;

  let replyTo: string | null = null;
  if (typeof body.replyTo === 'string' && body.replyTo.trim()) {
    if (!isValidEmail(body.replyTo)) {
      return { ok: false, error: INVALID_REQUEST('replyTo is not a valid email.'), recipients: emails, subject, html, text, senderEmail, senderName, replyTo: null, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
    }
    replyTo = body.replyTo.trim();
  }

  let campaignId: string | null = null;
  if (typeof body.campaignId === 'string' && body.campaignId.trim()) {
    const campaign = await ctx.env.DB.prepare('SELECT id FROM campaigns WHERE id = ?')
      .bind(body.campaignId.trim())
      .first();
    if (!campaign) {
      return { ok: false, error: INVALID_REQUEST('Campaign does not exist.'), recipients: emails, subject, html, text, senderEmail, senderName, replyTo, campaignId: null, trackLinks: false, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
    }
    campaignId = body.campaignId.trim();
  }

  const trackLinks = toBool(body.trackLinks, settings.defaultTracking);

  // scheduledAt: ISO-8601 with timezone -> Brevo wants 'YYYY-MM-DDTHH:mm:ss.SSSZ'
  let scheduledAt: string | null = null;
  if (typeof body.scheduledAt === 'string' && body.scheduledAt.trim()) {
    const ts = Date.parse(body.scheduledAt);
    if (!Number.isFinite(ts)) {
      return { ok: false, error: INVALID_REQUEST('scheduledAt must be a valid date-time.'), recipients: emails, subject, html, text, senderEmail, senderName, replyTo, campaignId, trackLinks, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
    }
    if (ts <= Date.now()) {
      return { ok: false, error: INVALID_REQUEST('scheduledAt must be in the future.'), recipients: emails, subject, html, text, senderEmail, senderName, replyTo, campaignId, trackLinks, scheduledAt: null, tags: [], templateId: null, params: {}, draftId: null, urls: [] };
    }
    scheduledAt = new Date(ts).toISOString();
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 50)).filter(Boolean).slice(0, 10)
    : [];

  let templateId: number | null = null;
  if (body.templateId !== undefined && body.templateId !== null && body.templateId !== '') {
    templateId = Number(body.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      return { ok: false, error: INVALID_REQUEST('templateId must be a positive integer.'), recipients: emails, subject, html, text, senderEmail, senderName, replyTo, campaignId, trackLinks, scheduledAt, tags, templateId: null, params: {}, draftId: null, urls: [] };
    }
  }

  const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
    ? body.params as Record<string, unknown>
    : {};

  const draftId = typeof body.draftId === 'string' && body.draftId ? body.draftId : null;

  const urls = trackLinks ? extractUrls(`${html}\n${text}`) : [];

  return {
    ok: true,
    recipients: emails,
    subject,
    html,
    text,
    senderEmail,
    senderName,
    replyTo,
    campaignId,
    trackLinks,
    scheduledAt,
    tags,
    templateId,
    params,
    draftId,
    urls,
  };
}

interface DraftResult {
  row: EmailRow;
  trackedLinks: UrlMapping[];
  transformed: { html: string; text: string } | null;
}

/**
 * Create (or refresh) a draft email for ONE recipient with its tracked links.
 * Used by /api/mail/drafts and /api/mail/preview.
 */
export async function createEmailForRecipient(
  ctx: Ctx,
  body: ComposeBody,
  user: UserRow,
  opts: { draft: boolean },
): Promise<DraftResult> {
  const v = await validateComposeInput(ctx, body);
  if (!v.ok) throw new ApiHttpError(v.error!);

  const anchorId = typeof body.draftId === 'string' && body.draftId ? body.draftId : null;
  const groupId = crypto.randomUUID();
  const recipient = v.recipients[0]!;

  // Reuse the draft if a draftId was given and it belongs to this user.
  let email: EmailRow | null = null;
  if (anchorId) {
    const existing = await getEmailById(ctx.env, anchorId);
    if (existing && existing.status === 'draft') {
      email = existing;
      await updateEmail(ctx.env, existing.id, {
        recipient,
        subject: v.subject,
        html_content: v.html,
        text_content: v.text,
        sender_email: v.senderEmail,
        sender_name: v.senderName,
        reply_to: v.replyTo,
        campaign_id: v.campaignId,
        track_links: v.trackLinks ? 1 : 0,
        tags: v.tags.length ? JSON.stringify(v.tags) : null,
      });
    }
  }

  if (!email) {
    email = await insertEmail(ctx.env, {
      campaignId: v.campaignId,
      senderEmail: v.senderEmail,
      senderName: v.senderName || null,
      recipient,
      subject: v.subject,
      status: opts.draft ? 'draft' : 'queued',
      htmlContent: v.html,
      textContent: v.text,
      tags: v.tags,
      trackLinks: v.trackLinks,
      replyTo: v.replyTo,
    });
    // Attach the batch group so sibling recipient rows share tracked links.
    await ctx.env.DB.prepare('UPDATE emails SET group_id = ? WHERE id = ?').bind(groupId, email.id).run();
  } else {
    // Keep the existing group for sibling rows.
  }

  let trackedLinks: UrlMapping[] = [];
  let transformed: { html: string; text: string } | null = null;
  if (v.trackLinks && v.urls.length > 0) {
    const mappings = await planUrlMappings(ctx.env, email.id, v.campaignId, v.urls);
    trackedLinks = await persistTrackedLinks(ctx.env, email.id, v.campaignId, user.id, mappings);
    const map = new Map(trackedLinks.map((m) => [m.original, m.finalUrl]));
    transformed = { html: applyMapping(v.html, map), text: applyMapping(v.text, map) };
  }

  return { row: email, trackedLinks, transformed };
}

/** Delete a draft email and its generated track links. */
export async function deleteDraftEmail(env: Ctx['env'], emailId: string): Promise<void> {
  const links = await env.DB.prepare('SELECT id FROM links WHERE email_id = ?').bind(emailId).all<{ id: string }>();
  for (const l of links.results) {
    await env.DB.prepare('DELETE FROM link_events WHERE link_id = ?').bind(l.id).run();
    await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(l.id).run();
  }
  await env.DB.prepare('DELETE FROM email_events WHERE email_id = ?').bind(emailId).run();
  await env.DB.prepare('DELETE FROM emails WHERE id = ?').bind(emailId).run();
}

export class ApiHttpError extends Error {
  response: Response;
  constructor(response: Response) {
    super('api-error');
    this.response = response;
  }
}

export interface SendResult {
  ok: boolean;
  httpError: Response | null;
  emails: EmailRow[];
  messageIds: string[];
  scheduled: boolean;
  trackedLinks: UrlMapping[];
}

/**
 * Send (or schedule) a transactional email through Brevo.
 * - Creates/refreshes one email row per recipient,
 * - rewrites URLs into /track/:slug links when trackLinks is enabled,
 * - calls Brevo POST /v3/smtp/email once with all recipients,
 * - maps Brevo messageIds back to per-recipient rows.
 */
export async function sendEmailNow(
  ctx: Ctx,
  body: ComposeBody,
  user: UserRow,
  opts: { test?: boolean } = {},
): Promise<SendResult> {
  // Rate limit mail sending (per user, per hour).
  const rl = await kvCheck(ctx.env, `mail:user:${user.id}`, 200, 3600);
  if (!rl.allowed) {
    return { ok: false, httpError: fail('RATE_LIMITED', 'Mail send limit reached for this hour.', 429), emails: [], messageIds: [], scheduled: false, trackedLinks: [] };
  }
  const ipRl = await kvCheck(ctx.env, ipKey('mail', ctx.request), 300, 3600);
  if (!ipRl.allowed) {
    return { ok: false, httpError: fail('RATE_LIMITED', 'Too many emails sent from this IP.', 429), emails: [], messageIds: [], scheduled: false, trackedLinks: [] };
  }

  const v = await validateComposeInput(ctx, body);
  if (!v.ok) return { ok: false, httpError: v.error ?? null, emails: [], messageIds: [], scheduled: false, trackedLinks: [] };

  const batchId = crypto.randomUUID();
  const draftId = v.draftId;

  // Build per-recipient email rows (reuse drafts when a draftId is given).
  const rows: EmailRow[] = [];
  for (const recipient of v.recipients) {
    let row: EmailRow | null = null;
    if (draftId) {
      const existing = await getEmailById(ctx.env, draftId);
      if (existing && existing.status === 'draft' && existing.recipient.toLowerCase() === recipient.toLowerCase()) {
        row = await updateEmail(ctx.env, existing.id, {
          recipient,
          subject: v.subject,
          html_content: v.html,
          text_content: v.text,
          sender_email: v.senderEmail,
          sender_name: v.senderName,
          reply_to: v.replyTo,
          campaign_id: v.campaignId,
          track_links: v.trackLinks ? 1 : 0,
          tags: v.tags.length ? JSON.stringify(v.tags) : null,
          status: 'queued',
        });
      }
    }
    if (!row) {
      row = await insertEmail(ctx.env, {
        campaignId: v.campaignId,
        senderEmail: v.senderEmail,
        senderName: v.senderName || null,
        recipient,
        subject: v.subject,
        status: 'queued',
        htmlContent: v.html,
        textContent: v.text,
        tags: v.tags,
        trackLinks: v.trackLinks,
        replyTo: v.replyTo,
      });
    }
    await ctx.env.DB.prepare('UPDATE emails SET group_id = ?, brevo_batch_id = ? WHERE id = ?')
      .bind(batchId, batchId, row.id)
      .run();
    rows.push(row);
  }

  // Tracked links: created for the anchor (first) row, shared by group_id.
  const anchorId = rows[0]!.id;
  let trackedLinks: UrlMapping[] = [];
  let htmlContent = v.html;
  let textContent = v.text;
  if (v.trackLinks && v.urls.length > 0) {
    const mappings = await planUrlMappings(ctx.env, anchorId, v.campaignId, v.urls);
    trackedLinks = await persistTrackedLinks(ctx.env, anchorId, v.campaignId, user.id, mappings);
    const map = new Map(trackedLinks.map((m) => [m.original, m.finalUrl]));
    htmlContent = applyMapping(v.html, map);
    textContent = applyMapping(v.text, map);
  }

  const brevo = await brevoSendTransactionalEmail(ctx.env, {
    sender: { email: v.senderEmail, name: v.senderName || undefined },
    to: v.recipients.map((email) => ({ email })),
    subject: v.subject,
    htmlContent: htmlContent || undefined,
    textContent: textContent || undefined,
    replyTo: v.replyTo ? { email: v.replyTo } : undefined,
    templateId: v.templateId ?? undefined,
    params: v.params,
    tags: [...v.tags, 'app:link-center', ...(opts.test ? ['test'] : [])],
    scheduledAt: v.scheduledAt ?? undefined,
  });

  const scheduled = Boolean(brevo.scheduled);
  const messageIds: string[] = [];

  if (!brevo.ok) {
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      await updateEmail(ctx.env, row.id, { status: 'failed', error: brevo.error || 'Brevo send failed.', sent_at: now });
    }
    return {
      ok: false,
      httpError: fail('BREVO_ERROR', brevo.error || 'Brevo send failed.', 502, { code: brevo.errorCode }),
      emails: rows,
      messageIds,
      scheduled: false,
      trackedLinks,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const status = scheduled ? 'scheduled' : 'sent';
  const ids = brevo.messageIds?.length ? brevo.messageIds : brevo.messageId ? [brevo.messageId] : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const messageId = ids[i] || undefined;
    await updateEmail(ctx.env, row.id, {
      status,
      brevo_message_id: messageId ?? null,
      sent_at: scheduled ? null : now,
      scheduled_at: scheduled ? Math.floor(Date.parse(v.scheduledAt!) / 1000) : null,
    });
    if (messageId) messageIds.push(messageId);
  }

  // Return fresh rows so callers see the persisted status/message ids.
  const freshRows: EmailRow[] = [];
  for (const row of rows) {
    freshRows.push((await getEmailById(ctx.env, row.id)) ?? row);
  }

  return { ok: true, httpError: null, emails: freshRows, messageIds, scheduled, trackedLinks };
}

/** Verify a single Brevo message-id maps to an internal email (used by tests). */
export async function findEmailByMessageId(env: Ctx['env'], messageId: string): Promise<EmailRow | null> {
  return getEmailByBrevoMessageId(env, messageId);
}
