import { cfg } from '../config';
import type { Ctx, LinkRow, PageMeta } from '../types';
import {
  campaignStats,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from '../lib/db-campaigns';
import {
  createEmailForRecipient,
  deleteDraftEmail,
  sendEmailNow,
} from '../lib/mail-send';
import {
  emailEventCounts,
  emailTrackedLinks,
  getEmailById,
  listEmails,
} from '../lib/db-emails';
import {
  deleteLink,
  getLinkById,
  insertLink,
  invalidateLinkCache,
  listLinks,
  slugExists,
  toggleLinkStatus,
  updateLink,
} from '../lib/db-links';
import { getGlobalAnalytics, getLinkAnalytics, getOverview } from '../lib/analytics';
import {
  CONFLICT,
  INVALID_REQUEST,
  NOT_FOUND,
  ok,
  readJson,
  fail,
} from '../lib/http';
import { maskBrevoKey, brevoAccountStatus, brevoListWebhooks } from '../lib/brevo';
import { buildSettings, updateSettings } from '../lib/settings';
import { randomSlug, validateCustomSlug } from '../lib/slug';
import { clampString, optionalInt, optionalString, validateDestinationUrl, isValidEmail } from '../lib/validate';
import { ApiHttpError } from '../lib/mail-send';
import { addRoute } from './router';
import { requireUser, requireUserMutation } from './helpers';

/* ============================================================================
 * /api/links
 * ==========================================================================*/

function linkPublicUrl(ctx: Ctx, link: LinkRow): string {
  return `${cfg(ctx.env).appUrl}/${link.type}/${link.slug}`;
}

addRoute('GET', '/api/links', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);
  const page = Number(url.searchParams.get('page') || 1);
  const perPage = Number(url.searchParams.get('perPage') || 20);
  const result = await listLinks(ctx.env, {
    search: url.searchParams.get('search') || undefined,
    type: url.searchParams.get('type') || undefined,
    status: url.searchParams.get('status') || undefined,
    campaignId: url.searchParams.get('campaignId') || undefined,
    sort: url.searchParams.get('sort') || undefined,
    page: Number.isFinite(page) ? page : 1,
    perPage: Number.isFinite(perPage) ? perPage : 20,
  });
  const meta: PageMeta = {
    page: Number.isFinite(page) ? page : 1,
    perPage: Number.isFinite(perPage) ? perPage : 20,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / (Number.isFinite(perPage) ? perPage : 20))),
  };
  return ok({
    items: result.items.map((l) => ({ ...l, publicUrl: linkPublicUrl(ctx, l) })),
    meta,
  });
});

addRoute('GET', '/api/links/:id', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const link = await getLinkById(ctx.env, ctx.params.id!);
  if (!link) return NOT_FOUND('Link not found.');
  return ok({ ...link, publicUrl: linkPublicUrl(ctx, link) });
});

addRoute('POST', '/api/links', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');

  const type = String(body.type || 'track');
  if (!['track', 'short', 'landing'].includes(type)) {
    return INVALID_REQUEST('Link type must be one of: track, short, landing.');
  }

  const { url, error: urlError } = validateDestinationUrl(body.destinationUrl);
  if (!url) return INVALID_REQUEST(urlError || 'Invalid destination URL.');

  // Slug: custom or auto-generated (collision-safe).
  let slug: string;
  if (typeof body.slug === 'string' && body.slug.trim().length > 0) {
    const customError = validateCustomSlug(body.slug.trim());
    if (customError) return INVALID_REQUEST(customError);
    slug = body.slug.trim();
    if (await slugExists(ctx.env, slug)) return CONFLICT(`Slug "${slug}" is already in use.`);
  } else {
    slug = await generateUniqueSlug(ctx);
  }

  const campaignId = typeof body.campaignId === 'string' && body.campaignId ? body.campaignId : null;
  if (campaignId && !(await getCampaign(ctx.env, campaignId))) {
    return INVALID_REQUEST('Campaign does not exist.');
  }

  const title = optionalString(body.title, 200);
  if (title.error) return INVALID_REQUEST(title.error);
  const description = optionalString(body.description, 1000);
  if (description.error) return INVALID_REQUEST(description.error);

  const expiresAt = optionalInt(body.expiresAt ?? body.expires_at, 0, 4102444800, null);
  if (expiresAt === null && body.expiresAt !== null && body.expiresAt !== undefined) {
    return INVALID_REQUEST('expiresAt must be a valid unix timestamp.');
  }

  const link = await insertLink(ctx.env, {
    slug,
    type,
    destinationUrl: url,
    title: title.value,
    description: description.value,
    buttonText: optionalString(body.buttonText, 80).value,
    iconUrl: optionalString(body.iconUrl, 500).value,
    imageUrl: optionalString(body.imageUrl, 1000).value,
    delaySeconds: optionalInt(body.delaySeconds, 0, 300, 0) ?? 0,
    status: body.status === 'disabled' ? 'disabled' : 'active',
    ownerId: auth.user.id,
    campaignId,
    emailId: null,
    expiresAt,
  });
  return ok({ ...link, publicUrl: linkPublicUrl(ctx, link) }, { status: 201 });
});

addRoute('PUT', '/api/links/:id', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const link = await getLinkById(ctx.env, ctx.params.id!);
  if (!link) return NOT_FOUND('Link not found.');
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');

  const patch: Parameters<typeof updateLink>[2] = {};
  if (body.destinationUrl !== undefined) {
    const { url, error } = validateDestinationUrl(body.destinationUrl);
    if (!url) return INVALID_REQUEST(error || 'Invalid destination URL.');
    patch.destinationUrl = url;
  }
  for (const [key, setter] of [
    ['title', (v: unknown) => optionalString(v, 200)],
    ['description', (v: unknown) => optionalString(v, 1000)],
    ['buttonText', (v: unknown) => optionalString(v, 80)],
    ['iconUrl', (v: unknown) => optionalString(v, 500)],
    ['imageUrl', (v: unknown) => optionalString(v, 1000)],
  ] as const) {
    if (body[key] !== undefined) {
      const r = setter(body[key]);
      if (r.error) return INVALID_REQUEST(r.error);
      (patch as Record<string, string | null>)[key] = r.value;
    }
  }
  if (body.delaySeconds !== undefined) {
    const d = optionalInt(body.delaySeconds, 0, 300, null);
    if (d === null) return INVALID_REQUEST('delaySeconds must be 0-300.');
    patch.delaySeconds = d;
  }
  if (body.status !== undefined) {
    if (!['active', 'disabled', 'archived'].includes(String(body.status))) {
      return INVALID_REQUEST('status must be one of: active, disabled, archived.');
    }
    patch.status = String(body.status);
  }
  if (body.campaignId !== undefined) {
    patch.campaignId = body.campaignId ? String(body.campaignId) : null;
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) patch.expiresAt = null;
    else {
      const e = optionalInt(body.expiresAt, 0, 4102444800, null);
      if (e === null) return INVALID_REQUEST('expiresAt must be a valid unix timestamp.');
      patch.expiresAt = e;
    }
  }

  const updated = await updateLink(ctx.env, link.id, patch);
  await invalidateLinkCache(ctx.env, link.slug);
  return ok(updated ? { ...updated, publicUrl: linkPublicUrl(ctx, updated) } : null);
});

addRoute('DELETE', '/api/links/:id', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const link = await getLinkById(ctx.env, ctx.params.id!);
  if (!link) return NOT_FOUND('Link not found.');
  await invalidateLinkCache(ctx.env, link.slug);
  await deleteLink(ctx.env, link.id);
  return ok({ deleted: true });
});

addRoute('POST', '/api/links/:id/duplicate', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const link = await getLinkById(ctx.env, ctx.params.id!);
  if (!link) return NOT_FOUND('Link not found.');
  const slug = await generateUniqueSlug(ctx);
  const copy = await insertLink(ctx.env, {
    slug,
    type: link.type,
    destinationUrl: link.destination_url,
    title: link.title,
    description: link.description,
    buttonText: link.button_text,
    iconUrl: link.icon_url,
    imageUrl: link.image_url,
    delaySeconds: link.delay_seconds,
    status: 'active',
    ownerId: auth.user.id,
    campaignId: link.campaign_id,
    emailId: null,
    expiresAt: link.expires_at,
    metadata: link.metadata ? JSON.parse(link.metadata) : undefined,
  });
  return ok({ ...copy, publicUrl: linkPublicUrl(ctx, copy) }, { status: 201 });
});

addRoute('POST', '/api/links/:id/toggle', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const link = await getLinkById(ctx.env, ctx.params.id!);
  if (!link) return NOT_FOUND('Link not found.');
  const updated = await toggleLinkStatus(ctx.env, link.id);
  await invalidateLinkCache(ctx.env, link.slug);
  return ok(updated ? { ...updated, publicUrl: linkPublicUrl(ctx, updated) } : null);
});

async function generateUniqueSlug(ctx: Ctx): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const slug = randomSlug(10);
    if (!(await slugExists(ctx.env, slug))) return slug;
  }
  return randomSlug(12);
}

/* ============================================================================
 * /api/links/:id/analytics
 * ==========================================================================*/

addRoute('GET', '/api/links/:id/analytics', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);
  const analytics = await getLinkAnalytics(
    ctx.env,
    ctx.params.id!,
    url.searchParams.get('range') || '30d',
    url.searchParams.get('from') || undefined,
    url.searchParams.get('to') || undefined,
  );
  if (!analytics) return NOT_FOUND('Link not found.');
  return ok(analytics);
});

/* ============================================================================
 * /api/campaigns
 * ==========================================================================*/

addRoute('GET', '/api/campaigns', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const campaigns = await listCampaigns(ctx.env);
  const withStats = await Promise.all(
    campaigns.map(async (c) => ({ ...c, stats: await campaignStats(ctx.env, c.id) })),
  );
  return ok({ items: withStats });
});

addRoute('POST', '/api/campaigns', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  const name = clampString(body.name, 120, 'Name');
  if (name.error) return INVALID_REQUEST(name.error);
  const description = optionalString(body.description, 1000);
  if (description.error) return INVALID_REQUEST(description.error);
  const campaign = await createCampaign(ctx.env, name.value, description.value);
  return ok(campaign, { status: 201 });
});

addRoute('GET', '/api/campaigns/:id', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const campaign = await getCampaign(ctx.env, ctx.params.id!);
  if (!campaign) return NOT_FOUND('Campaign not found.');
  const stats = await campaignStats(ctx.env, campaign.id);
  const links = await listLinks(ctx.env, { campaignId: campaign.id, page: 1, perPage: 100 });
  const emails = await listEmails(ctx.env, { campaignId: campaign.id, page: 1, perPage: 100 });
  return ok({
    ...campaign,
    stats,
    links: links.items.map((l) => ({ ...l, publicUrl: linkPublicUrl(ctx, l) })),
    emails: emails.items,
  });
});

addRoute('PUT', '/api/campaigns/:id', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const campaign = await getCampaign(ctx.env, ctx.params.id!);
  if (!campaign) return NOT_FOUND('Campaign not found.');
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  const patch: { name?: string; description?: string | null; status?: string } = {};
  if (body.name !== undefined) {
    const name = clampString(body.name, 120, 'Name');
    if (name.error) return INVALID_REQUEST(name.error);
    patch.name = name.value;
  }
  if (body.description !== undefined) patch.description = body.description ? String(body.description) : null;
  if (body.status !== undefined) {
    if (!['active', 'archived'].includes(String(body.status))) return INVALID_REQUEST('Invalid status.');
    patch.status = String(body.status);
  }
  const updated = await updateCampaign(ctx.env, campaign.id, patch);
  return ok(updated);
});

addRoute('DELETE', '/api/campaigns/:id', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const campaign = await getCampaign(ctx.env, ctx.params.id!);
  if (!campaign) return NOT_FOUND('Campaign not found.');
  await deleteCampaign(ctx.env, campaign.id);
  return ok({ deleted: true });
});

/* ============================================================================
 * /api/mail
 * ==========================================================================*/

async function composeDraft(ctx: Ctx, body: Record<string, unknown>, user: Ctx['user']) {
  try {
    return await createEmailForRecipient(ctx, body, user!, { draft: true });
  } catch (err) {
    if (err instanceof ApiHttpError) return err.response;
    throw err;
  }
}

addRoute('POST', '/api/mail/drafts', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  const email = await composeDraft(ctx, body, auth.user);
  if (email instanceof Response) return email;
  return ok({ email: email.row, trackedLinks: email.trackedLinks, transformed: email.transformed }, { status: 201 });
});

addRoute('POST', '/api/mail/preview', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  const email = await composeDraft(ctx, body, auth.user);
  if (email instanceof Response) return email;
  return ok({
    email: email.row,
    transformedHtml: email.transformed?.html ?? email.row.html_content,
    transformedText: email.transformed?.text ?? email.row.text_content,
    trackedLinks: email.trackedLinks,
    subject: email.row.subject,
  });
});

addRoute('POST', '/api/mail/send', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  const result = await sendEmailNow(ctx, body, auth.user);
  if (!result.ok && result.httpError) return result.httpError;
  return ok({
    emails: result.emails,
    messageIds: result.messageIds,
    scheduled: result.scheduled,
    trackedLinks: result.trackedLinks,
  }, { status: result.scheduled ? 202 : 200 });
});

addRoute('POST', '/api/mail/test', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  const testTo = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : body.testTo;
  const result = await sendEmailNow(ctx, { ...body, to: testTo, draft: false }, auth.user, { test: true });
  if (!result.ok && result.httpError) return result.httpError;
  return ok({ emails: result.emails, messageIds: result.messageIds });
});

addRoute('GET', '/api/mail/history', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);
  const page = Number(url.searchParams.get('page') || 1);
  const perPage = Number(url.searchParams.get('perPage') || 20);
  const result = await listEmails(ctx.env, {
    search: url.searchParams.get('search') || undefined,
    status: url.searchParams.get('status') || undefined,
    campaignId: url.searchParams.get('campaignId') || undefined,
    page: Number.isFinite(page) ? page : 1,
    perPage: Number.isFinite(perPage) ? perPage : 20,
  });
  const counts = await emailEventCounts(ctx.env, result.items.map((e) => e.id));
  const meta: PageMeta = {
    page: Number.isFinite(page) ? page : 1,
    perPage: Number.isFinite(perPage) ? perPage : 20,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / (Number.isFinite(perPage) ? perPage : 20))),
  };
  return ok({
    items: result.items.map((e) => ({
      ...e,
      opens: counts.get(e.id)?.opens ?? 0,
      clicks: counts.get(e.id)?.clicks ?? 0,
    })),
    meta,
  });
});

addRoute('GET', '/api/mail/:id', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const email = await getEmailById(ctx.env, ctx.params.id!);
  if (!email) return NOT_FOUND('Email not found.');
  const events = await ctx.env.DB.prepare(
    'SELECT id, event_type, event_timestamp, url, ip FROM email_events WHERE email_id = ? ORDER BY id ASC',
  )
    .bind(email.id)
    .all<{ id: number; event_type: string; event_timestamp: number; url: string | null; ip: string | null }>();
  const links = await emailTrackedLinks(ctx.env, email.id);
  return ok({
    email,
    events: events.results.map((e) => ({ ...e, event_timestamp: Number(e.event_timestamp) })),
    trackedLinks: links,
  });
});

addRoute('DELETE', '/api/mail/:id', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const email = await getEmailById(ctx.env, ctx.params.id!);
  if (!email) return NOT_FOUND('Email not found.');
  if (email.status === 'scheduled') {
    return fail('SCHEDULED_EMAIL', 'Scheduled emails cannot be deleted via the dashboard. Cancel it in Brevo first.', 409);
  }
  if (email.status !== 'draft' && email.status !== 'failed') {
    return fail('EMAIL_ALREADY_SENT', 'Only draft or failed emails can be deleted.', 409);
  }
  await deleteDraftEmail(ctx.env, email.id);
  return ok({ deleted: true });
});

/* ============================================================================
 * /api/analytics (global) + /api/overview
 * ==========================================================================*/

addRoute('GET', '/api/analytics', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);
  const data = await getGlobalAnalytics(
    ctx.env,
    url.searchParams.get('range') || '30d',
    url.searchParams.get('from') || undefined,
    url.searchParams.get('to') || undefined,
  );
  return ok(data);
});

addRoute('GET', '/api/overview', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  return ok(await getOverview(ctx.env));
});

/* ============================================================================
 * /api/settings
 * ==========================================================================*/

addRoute('GET', '/api/settings', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  return ok(await buildSettings(ctx.env));
});

addRoute('PUT', '/api/settings', async (ctx: Ctx) => {
  const auth = await requireUserMutation(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return INVALID_REQUEST('Invalid JSON body.');
  if (body.brevoSenderEmail !== undefined && body.brevoSenderEmail !== '') {
    if (!isValidEmail(body.brevoSenderEmail)) return INVALID_REQUEST('Sender email is not valid.');
  }
  const settings = await updateSettings(ctx.env, body);
  return ok(settings);
});

addRoute('GET', '/api/settings/brevo/status', async (ctx: Ctx) => {
  const auth = await requireUser(ctx);
  if (auth instanceof Response) return auth;
  const settings = await buildSettings(ctx.env);
  const account = await brevoAccountStatus(ctx.env);
  const webhooks = await brevoListWebhooks(ctx.env);
  return ok({
    configured: settings.brevoConfigured,
    keyMasked: maskBrevoKey(ctx.env.BREVO_API_KEY),
    account,
    webhookSecretSet: settings.webhookSecretSet,
    webhookUrl: settings.webhookUrl,
    webhooks: webhooks.webhooks.slice(0, 20),
  });
});

export { linkPublicUrl };

/** Routes are registered on module import; exists for symmetry with other registrars. */
export function registerApiRoutes(): void {}
