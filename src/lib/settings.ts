import type { Env } from '../types';

/**
 * Dashboard settings persisted in the `settings` table.
 * Secrets (Brevo API key etc.) are NEVER stored here — they live only in
 * Cloudflare secrets.
 */

export interface AppSettings {
  siteName: string;
  defaultRedirectStatus: '301' | '302';
  timezone: string;
  brevoSenderEmail: string;
  brevoSenderName: string;
  brevoConfigured: boolean;
  brevoKeyMasked: string | null;
  webhookUrl: string;
  webhookSecretSet: boolean;
  defaultTracking: boolean;
  analyticsRetentionDays: number;
  privacyAggregateOnly: boolean;
  sessionDays: number;
  loginRateLimit: number;
  apiRateLimit: number;
}

const DEFAULTS: Record<string, string> = {
  siteName: 'Link Center',
  defaultRedirectStatus: '302',
  timezone: 'Asia/Ho_Chi_Minh',
  brevoSenderEmail: '',
  brevoSenderName: '',
  defaultTracking: 'true',
  analyticsRetentionDays: '365',
  privacyAggregateOnly: 'false',
};

export async function getSettingsRow(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSettingsRow(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  )
    .bind(key, value)
    .run();
}

export async function getSetting(env: Env, key: string): Promise<string> {
  return (await getSettingsRow(env, key)) ?? DEFAULTS[key] ?? '';
}

export async function buildSettings(env: Env): Promise<AppSettings> {
  const [siteName, redirectStatus, timezone, senderEmail, senderName, tracking, retention, privacy] =
    await Promise.all([
      getSetting(env, 'siteName'),
      getSetting(env, 'defaultRedirectStatus'),
      getSetting(env, 'timezone'),
      getSetting(env, 'brevoSenderEmail'),
      getSetting(env, 'brevoSenderName'),
      getSetting(env, 'defaultTracking'),
      getSetting(env, 'analyticsRetentionDays'),
      getSetting(env, 'privacyAggregateOnly'),
    ]);
  const brevoKeyMasked = env.BREVO_API_KEY ? `••••••••${env.BREVO_API_KEY.slice(-4)}` : null;
  return {
    siteName: siteName || 'Link Center',
    defaultRedirectStatus: redirectStatus === '301' ? '301' : '302',
    timezone: timezone || 'Asia/Ho_Chi_Minh',
    brevoSenderEmail: senderEmail || env.BREVO_SENDER_EMAIL || '',
    brevoSenderName: senderName || env.BREVO_SENDER_NAME || '',
    brevoConfigured: Boolean(env.BREVO_API_KEY),
    brevoKeyMasked,
    webhookUrl: `${env.APP_URL || ''}/api/webhooks/brevo`,
    webhookSecretSet: Boolean(env.BREVO_WEBHOOK_SECRET),
    defaultTracking: tracking !== 'false',
    analyticsRetentionDays: Number.parseInt(retention, 10) || 365,
    privacyAggregateOnly: privacy === 'true',
    sessionDays: Number.parseInt(env.SESSION_DAYS || '30', 10) || 30,
    loginRateLimit: Number.parseInt(env.LOGIN_RATE_LIMIT || '10', 10) || 10,
    apiRateLimit: Number.parseInt(env.API_RATE_LIMIT || '300', 10) || 300,
  };
}

export async function updateSettings(env: Env, patch: Record<string, unknown>): Promise<AppSettings> {
  const stringKeys = ['siteName', 'defaultRedirectStatus', 'timezone', 'brevoSenderEmail', 'brevoSenderName'];
  const boolKeys = ['defaultTracking', 'privacyAggregateOnly'];
  const intKeys = ['analyticsRetentionDays'];

  for (const key of stringKeys) {
    if (typeof patch[key] === 'string') await setSettingsRow(env, key, (patch[key] as string).trim());
  }
  for (const key of boolKeys) {
    if (typeof patch[key] === 'boolean') await setSettingsRow(env, key, patch[key] ? 'true' : 'false');
  }
  for (const key of intKeys) {
    const v = Number(patch[key]);
    if (Number.isFinite(v) && v > 0) await setSettingsRow(env, key, String(Math.min(3650, Math.floor(v))));
  }
  return buildSettings(env);
}
