import type { Env } from './types';

/** Small typed config helper reading env vars with defaults. */
export function cfg(env: Env): {
  appName: string;
  appUrl: string;
  redirectStatus: 301 | 302;
  sessionDays: number;
  loginRateLimit: number;
  loginRateWindow: number;
  apiRateLimit: number;
  apiRateWindow: number;
  analyticsRetentionDays: number;
  brevoBaseUrl: string;
} {
  return {
    appName: env.APP_NAME || 'Link Center',
    appUrl: (env.APP_URL || '').replace(/\/+$/, ''),
    redirectStatus: env.DEFAULT_REDIRECT_STATUS === '301' ? 301 : 302,
    sessionDays: parseIntSafe(env.SESSION_DAYS, 30),
    loginRateLimit: parseIntSafe(env.LOGIN_RATE_LIMIT, 10),
    loginRateWindow: parseIntSafe(env.LOGIN_RATE_WINDOW_SECONDS, 300),
    apiRateLimit: parseIntSafe(env.API_RATE_LIMIT, 300),
    apiRateWindow: parseIntSafe(env.API_RATE_WINDOW_SECONDS, 60),
    analyticsRetentionDays: parseIntSafe(env.ANALYTICS_RETENTION_DAYS, 365),
    brevoBaseUrl: (env.BREVO_API_BASE_URL || 'https://api.brevo.com/v3').replace(/\/+$/, ''),
  };
}

function parseIntSafe(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when the request is served over https. */
export function isSecureRequest(request: Request): boolean {
  return request.url.startsWith('https://');
}
