import type { Env, LinkRow } from '../types';

/** Map a D1 row (snake_case) to a LinkRow. */
function mapLink(row: Record<string, unknown>): LinkRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    type: row.type as LinkRow['type'],
    kind: (row.kind as LinkRow['kind']) || 'manual',
    destination_url: String(row.destination_url),
    title: (row.title as string) ?? null,
    description: (row.description as string) ?? null,
    button_text: (row.button_text as string) ?? null,
    icon_url: (row.icon_url as string) ?? null,
    image_url: (row.image_url as string) ?? null,
    delay_seconds: Number(row.delay_seconds ?? 0),
    status: row.status as LinkRow['status'],
    owner_id: (row.owner_id as string) ?? null,
    campaign_id: (row.campaign_id as string) ?? null,
    email_id: (row.email_id as string) ?? null,
    expires_at: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    click_count: Number(row.click_count ?? 0),
    unique_visitors: Number(row.unique_visitors ?? 0),
    metadata: (row.metadata as string) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    campaign_name: (row.campaign_name as string) ?? null,
  };
}

const LINK_SELECT = `
  SELECT l.*, c.name AS campaign_name
  FROM links l LEFT JOIN campaigns c ON c.id = l.campaign_id
`;

export async function getLinkBySlug(env: Env, slug: string): Promise<LinkRow | null> {
  const row = await env.DB.prepare(`${LINK_SELECT} WHERE l.slug = ?`).bind(slug).first();
  return row ? mapLink(row as Record<string, unknown>) : null;
}

export async function getLinkById(env: Env, id: string): Promise<LinkRow | null> {
  const row = await env.DB.prepare(`${LINK_SELECT} WHERE l.id = ?`).bind(id).first();
  return row ? mapLink(row as Record<string, unknown>) : null;
}

export async function slugExists(env: Env, slug: string, excludeId?: string): Promise<boolean> {
  const row = excludeId
    ? await env.DB.prepare('SELECT id FROM links WHERE slug = ? AND id != ?').bind(slug, excludeId).first()
    : await env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first();
  return Boolean(row);
}

export interface CreateLinkInput {
  slug?: string;
  type: string;
  destinationUrl: string;
  title?: string | null;
  description?: string | null;
  buttonText?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
  delaySeconds?: number;
  status?: string;
  ownerId: string | null;
  campaignId?: string | null;
  emailId?: string | null;
  expiresAt?: number | null;
  kind?: 'manual' | 'email';
  metadata?: Record<string, unknown>;
}

export async function insertLink(env: Env, input: CreateLinkInput): Promise<LinkRow> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO links
       (id, slug, type, kind, destination_url, title, description, button_text, icon_url, image_url,
        delay_seconds, status, owner_id, campaign_id, email_id, expires_at, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.slug!,
      input.type,
      input.kind || 'manual',
      input.destinationUrl,
      input.title ?? null,
      input.description ?? null,
      input.buttonText ?? null,
      input.iconUrl ?? null,
      input.imageUrl ?? null,
      input.delaySeconds ?? 0,
      input.status || 'active',
      input.ownerId,
      input.campaignId ?? null,
      input.emailId ?? null,
      input.expiresAt ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    )
    .run();
  return (await getLinkById(env, id))!;
}

export interface UpdateLinkInput {
  destinationUrl?: string;
  title?: string | null;
  description?: string | null;
  buttonText?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
  delaySeconds?: number;
  status?: string;
  campaignId?: string | null;
  expiresAt?: number | null;
}

export async function updateLink(env: Env, id: string, input: UpdateLinkInput): Promise<LinkRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const fields: [string, unknown][] = [
    ['destination_url', input.destinationUrl],
    ['title', input.title],
    ['description', input.description],
    ['button_text', input.buttonText],
    ['icon_url', input.iconUrl],
    ['image_url', input.imageUrl],
    ['delay_seconds', input.delaySeconds],
    ['status', input.status],
    ['campaign_id', input.campaignId],
    ['expires_at', input.expiresAt],
  ];
  for (const [col, v] of fields) {
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      values.push(v);
    }
  }
  if (sets.length === 0) return getLinkById(env, id);
  sets.push('updated_at = unixepoch()');
  values.push(id);
  await env.DB.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return getLinkById(env, id);
}

export interface LinkListQuery {
  search?: string;
  type?: string;
  status?: string;
  campaignId?: string;
  sort?: string;
  page: number;
  perPage: number;
}

export interface LinkListResult {
  items: LinkRow[];
  total: number;
}

export async function listLinks(env: Env, q: LinkListQuery): Promise<LinkListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (q.search) {
    where.push('(l.slug LIKE ? OR l.title LIKE ? OR l.destination_url LIKE ?)');
    const like = `%${q.search}%`;
    values.push(like, like, like);
  }
  if (q.type) {
    where.push('l.type = ?');
    values.push(q.type);
  }
  if (q.status) {
    where.push('l.status = ?');
    values.push(q.status);
  }
  if (q.campaignId) {
    where.push('l.campaign_id = ?');
    values.push(q.campaignId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orderMap: Record<string, string> = {
    created: 'l.created_at DESC',
    'created_asc': 'l.created_at ASC',
    clicks: 'l.click_count DESC',
    clicks_asc: 'l.click_count ASC',
    slug: 'l.slug ASC',
    type: 'l.type ASC',
    status: 'l.status ASC',
    expires: 'l.expires_at ASC NULLS LAST',
  };
  const order = orderMap[q.sort || 'created'] || orderMap.created;

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM links l ${whereSql}`)
    .bind(...values)
    .first<{ n: number }>();
  const total = Number(totalRow?.n ?? 0);

  const page = Math.max(1, q.page);
  const perPage = Math.min(100, Math.max(1, q.perPage));
  const rows = await env.DB.prepare(
    `${LINK_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...values, perPage, (page - 1) * perPage)
    .all<Record<string, unknown>>();

  return { items: rows.results.map(mapLink), total };
}

export async function deleteLink(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
}

export async function toggleLinkStatus(env: Env, id: string): Promise<LinkRow | null> {
  const link = await getLinkById(env, id);
  if (!link) return null;
  const next = link.status === 'active' ? 'disabled' : 'active';
  return updateLink(env, id, { status: next });
}

/** Invalidate the KV cache entry for a slug after writes. */
export async function invalidateLinkCache(env: Env, slug: string): Promise<void> {
  try {
    await env.KV.delete(`link:${slug}`);
  } catch {
    /* cache invalidation is best-effort */
  }
}

/** Public lookup with a short-lived KV cache to keep the hot path cheap. */
export async function getLinkBySlugCached(env: Env, slug: string): Promise<LinkRow | null> {
  try {
    const cached = await env.KV.get(`link:${slug}`, 'json');
    if (cached) return cached as LinkRow;
  } catch {
    /* fall through to DB */
  }
  const link = await getLinkBySlug(env, slug);
  if (link) {
    try {
      await env.KV.put(`link:${slug}`, JSON.stringify(link), { expirationTtl: 60 });
    } catch {
      /* caching best-effort */
    }
  }
  return link;
}
