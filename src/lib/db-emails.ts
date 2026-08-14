import type { EmailRow, Env } from '../types';

function mapEmail(row: Record<string, unknown>): EmailRow {
  return {
    id: String(row.id),
    campaign_id: (row.campaign_id as string) ?? null,
    sender_email: String(row.sender_email),
    sender_name: (row.sender_name as string) ?? null,
    recipient: String(row.recipient),
    subject: String(row.subject),
    status: String(row.status),
    brevo_message_id: (row.brevo_message_id as string) ?? null,
    brevo_batch_id: (row.brevo_batch_id as string) ?? null,
    scheduled_at: row.scheduled_at === null || row.scheduled_at === undefined ? null : Number(row.scheduled_at),
    sent_at: row.sent_at === null || row.sent_at === undefined ? null : Number(row.sent_at),
    html_content: (row.html_content as string) ?? null,
    text_content: (row.text_content as string) ?? null,
    tags: (row.tags as string) ?? null,
    track_links: Number(row.track_links ?? 0),
    reply_to: (row.reply_to as string) ?? null,
    error: (row.error as string) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    campaign_name: (row.campaign_name as string) ?? null,
  };
}

const EMAIL_SELECT = `
  SELECT e.*, c.name AS campaign_name
  FROM emails e LEFT JOIN campaigns c ON c.id = e.campaign_id
`;

/**
 * Human-friendly sequential id: YYYY-MMDD-NNN (displayed as #2026-0814-001).
 * Retries on the (rare) unique collision when two drafts are created in the
 * same instant.
 */
export async function nextEmailId(env: Env): Promise<string> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const prefix = `${y}-${m}${d}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM emails WHERE id LIKE ? || '-%'")
      .bind(prefix)
      .first<{ n: number }>();
    const seq = Number(row?.n ?? 0) + 1;
    const id = `${prefix}-${String(seq).padStart(3, '0')}`;
    const exists = await env.DB.prepare('SELECT id FROM emails WHERE id = ?').bind(id).first();
    if (!exists) return id;
  }
  // Extremely unlikely fallback: timestamp suffix.
  return `${prefix}-${String(Math.floor(Date.now() / 1000) % 100000).padStart(3, '0')}`;
}

export interface CreateEmailInput {
  id?: string;
  campaignId?: string | null;
  senderEmail: string;
  senderName?: string | null;
  recipient: string;
  subject: string;
  status?: string;
  htmlContent?: string | null;
  textContent?: string | null;
  tags?: string[] | null;
  trackLinks?: boolean;
  replyTo?: string | null;
  scheduledAt?: number | null;
  brevoMessageId?: string | null;
}

export async function insertEmail(env: Env, input: CreateEmailInput): Promise<EmailRow> {
  const id = input.id || (await nextEmailId(env));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO emails
       (id, campaign_id, sender_email, sender_name, recipient, subject, status,
        html_content, text_content, tags, track_links, reply_to, scheduled_at,
        brevo_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.campaignId ?? null,
      input.senderEmail,
      input.senderName ?? null,
      input.recipient,
      input.subject,
      input.status || 'draft',
      input.htmlContent ?? null,
      input.textContent ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.trackLinks ? 1 : 0,
      input.replyTo ?? null,
      input.scheduledAt ?? null,
      input.brevoMessageId ?? null,
      now,
      now,
    )
    .run();
  return (await getEmailById(env, id))!;
}

export async function getEmailById(env: Env, id: string): Promise<EmailRow | null> {
  const row = await env.DB.prepare(`${EMAIL_SELECT} WHERE e.id = ?`).bind(id).first();
  return row ? mapEmail(row as Record<string, unknown>) : null;
}

export async function getEmailByBrevoMessageId(env: Env, messageId: string): Promise<EmailRow | null> {
  const row = await env.DB.prepare(`${EMAIL_SELECT} WHERE e.brevo_message_id = ?`).bind(messageId).first();
  return row ? mapEmail(row as Record<string, unknown>) : null;
}

export async function updateEmail(env: Env, id: string, patch: Partial<EmailRow>): Promise<EmailRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const fields: [string, unknown | undefined][] = [
    ['campaign_id', patch.campaign_id],
    ['sender_email', patch.sender_email],
    ['sender_name', patch.sender_name],
    ['recipient', patch.recipient],
    ['subject', patch.subject],
    ['status', patch.status],
    ['brevo_message_id', patch.brevo_message_id],
    ['brevo_batch_id', patch.brevo_batch_id],
    ['scheduled_at', patch.scheduled_at],
    ['sent_at', patch.sent_at],
    ['html_content', patch.html_content],
    ['text_content', patch.text_content],
    ['tags', patch.tags],
    ['track_links', patch.track_links],
    ['reply_to', patch.reply_to],
    ['error', patch.error],
  ];
  for (const [col, v] of fields) {
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      values.push(v);
    }
  }
  if (sets.length === 0) return getEmailById(env, id);
  sets.push('updated_at = unixepoch()');
  values.push(id);
  await env.DB.prepare(`UPDATE emails SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return getEmailById(env, id);
}

export interface EmailListQuery {
  search?: string;
  status?: string;
  campaignId?: string;
  page: number;
  perPage: number;
}

export interface EmailListResult {
  items: EmailRow[];
  total: number;
}

export async function listEmails(env: Env, q: EmailListQuery): Promise<EmailListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (q.search) {
    where.push('(e.subject LIKE ? OR e.recipient LIKE ? OR e.id LIKE ?)');
    const like = `%${q.search}%`;
    values.push(like, like, like);
  }
  if (q.status) {
    where.push('e.status = ?');
    values.push(q.status);
  }
  if (q.campaignId) {
    where.push('e.campaign_id = ?');
    values.push(q.campaignId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM emails e ${whereSql}`)
    .bind(...values)
    .first<{ n: number }>();
  const total = Number(totalRow?.n ?? 0);
  const page = Math.max(1, q.page);
  const perPage = Math.min(100, Math.max(1, q.perPage));
  const rows = await env.DB.prepare(
    `${EMAIL_SELECT} ${whereSql} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...values, perPage, (page - 1) * perPage)
    .all<Record<string, unknown>>();
  return { items: rows.results.map(mapEmail), total };
}

/** Opens/clicks counts per email (from email_events). */
export async function emailEventCounts(env: Env, ids: string[]): Promise<Map<string, { opens: number; clicks: number }>> {
  const map = new Map<string, { opens: number; clicks: number }>();
  if (ids.length === 0) return map;
  for (const id of ids) map.set(id, { opens: 0, clicks: 0 });
  // Chunk to stay under SQLite variable limits.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT email_id, event_type, COUNT(*) AS n FROM email_events
       WHERE email_id IN (${placeholders}) AND event_type IN ('opened','click')
       GROUP BY email_id, event_type`,
    )
      .bind(...chunk)
      .all<{ email_id: string; event_type: string; n: number }>();
    for (const row of rows.results) {
      const entry = map.get(row.email_id);
      if (!entry) continue;
      if (row.event_type === 'opened') entry.opens += Number(row.n);
      else if (row.event_type === 'click') entry.clicks += Number(row.n);
    }
  }
  return map;
}

/** Track links generated for an email (any recipient of the same group). */
export async function emailTrackedLinks(env: Env, emailId: string): Promise<Array<{ id: string; slug: string; destination_url: string; click_count: number; unique_visitors: number }>> {
  const rows = await env.DB.prepare(
    `SELECT l.id, l.slug, l.destination_url, l.click_count, l.unique_visitors
     FROM links l
     WHERE l.email_id = ?
        OR l.email_id IN (SELECT id FROM emails WHERE group_id = (SELECT group_id FROM emails WHERE id = ?))
     ORDER BY l.created_at ASC`,
  )
    .bind(emailId, emailId)
    .all<{ id: string; slug: string; destination_url: string; click_count: number; unique_visitors: number }>();
  return rows.results;
}
