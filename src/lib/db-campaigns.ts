import type { CampaignRow, Env } from '../types';

function mapCampaign(row: Record<string, unknown>): CampaignRow {
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string) ?? null,
    status: String(row.status),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export async function listCampaigns(env: Env): Promise<CampaignRow[]> {
  const rows = await env.DB.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all<Record<string, unknown>>();
  return rows.results.map(mapCampaign);
}

export async function getCampaign(env: Env, id: string): Promise<CampaignRow | null> {
  const row = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
  return row ? mapCampaign(row as Record<string, unknown>) : null;
}

export async function createCampaign(env: Env, name: string, description: string | null): Promise<CampaignRow> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO campaigns (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, description, now, now)
    .run();
  return (await getCampaign(env, id))!;
}

export async function updateCampaign(
  env: Env,
  id: string,
  input: { name?: string; description?: string | null; status?: string },
): Promise<CampaignRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(input.description);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    values.push(input.status);
  }
  if (sets.length === 0) return getCampaign(env, id);
  sets.push('updated_at = unixepoch()');
  values.push(id);
  await env.DB.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return getCampaign(env, id);
}

export async function deleteCampaign(env: Env, id: string): Promise<void> {
  // Links keep existing but lose the campaign reference (ON DELETE SET NULL).
  await env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(id).run();
}

export interface CampaignStats {
  emailsSent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  linkClicks: number;
  linkUniques: number;
}

/** Aggregated campaign analytics (emails + tracked links). */
export async function campaignStats(env: Env, campaignId: string): Promise<CampaignStats> {
  const emailRow = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('opened','clicked') THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) AS clicked,
       SUM(CASE WHEN status IN ('hard_bounce','soft_bounce','blocked','invalid') THEN 1 ELSE 0 END) AS bounced
     FROM emails WHERE campaign_id = ?`,
  )
    .bind(campaignId)
    .first<{ total: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number }>();
  const linkRow = await env.DB.prepare(
    'SELECT COALESCE(SUM(click_count),0) AS clicks, COALESCE(SUM(unique_visitors),0) AS uniques FROM links WHERE campaign_id = ?',
  )
    .bind(campaignId)
    .first<{ clicks: number; uniques: number }>();
  return {
    emailsSent: Number(emailRow?.sent ?? 0),
    delivered: Number(emailRow?.delivered ?? 0),
    opened: Number(emailRow?.opened ?? 0),
    clicked: Number(emailRow?.clicked ?? 0),
    bounced: Number(emailRow?.bounced ?? 0),
    linkClicks: Number(linkRow?.clicks ?? 0),
    linkUniques: Number(linkRow?.uniques ?? 0),
  };
}
