/**
 * Shared types for the link-center Worker.
 */

/** Worker environment bindings (wrangler.toml + secrets). */
export interface Env {
  // Bindings
  DB: D1Database;
  KV: KVNamespace;

  // Vars (wrangler.toml [vars])
  APP_NAME: string;
  APP_URL: string;
  DEFAULT_REDIRECT_STATUS?: string;
  SESSION_DAYS?: string;
  LOGIN_RATE_LIMIT?: string;
  LOGIN_RATE_WINDOW_SECONDS?: string;
  API_RATE_LIMIT?: string;
  API_RATE_WINDOW_SECONDS?: string;
  ANALYTICS_RETENTION_DAYS?: string;
  BREVO_API_BASE_URL?: string;

  // Secrets (wrangler secret put) — never exposed to the client.
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  BREVO_SENDER_NAME?: string;
  BREVO_WEBHOOK_SECRET?: string;
  CLICK_SALT?: string;
  /** Optional: when set, the first-run setup page requires this token. */
  SETUP_TOKEN?: string;
}

/** Value returned by the router with matched path params. */
export interface RouteParams {
  [key: string]: string | undefined;
}

/** Per-request context passed to route handlers. */
export interface Ctx {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  params: RouteParams;
  /** Verified session user (set by auth middleware). */
  user?: UserRow;
  /** True when the request comes over https (drives Secure cookies/HSTS). */
  secure: boolean;
  /** Request id for tracing. */
  requestId: string;
}

export type LinkType = 'track' | 'short' | 'landing';
export type LinkKind = 'manual' | 'email';
export type LinkStatus = 'active' | 'disabled' | 'archived';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: number;
}

export interface LinkRow {
  id: string;
  slug: string;
  type: LinkType;
  kind: LinkKind;
  destination_url: string;
  title: string | null;
  description: string | null;
  button_text: string | null;
  icon_url: string | null;
  image_url: string | null;
  delay_seconds: number;
  status: LinkStatus;
  owner_id: string | null;
  campaign_id: string | null;
  email_id: string | null;
  expires_at: number | null;
  click_count: number;
  unique_visitors: number;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  campaign_name?: string | null;
}

export interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface EmailRow {
  id: string;
  campaign_id: string | null;
  sender_email: string;
  sender_name: string | null;
  recipient: string;
  subject: string;
  status: string;
  brevo_message_id: string | null;
  brevo_batch_id: string | null;
  scheduled_at: number | null;
  sent_at: number | null;
  html_content: string | null;
  text_content: string | null;
  tags: string | null;
  track_links: number;
  reply_to: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  campaign_name?: string | null;
}

/** Standard JSON envelope. */
export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = {
  success: false;
  error: { code: string; message: string; details?: unknown };
};
export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

/** Pagination metadata. */
export interface PageMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Click event category (device/browser/os/country buckets). */
export interface CategoryCount {
  name: string;
  count: number;
}

/** Analytics payload for a link. */
export interface LinkAnalytics {
  link: Pick<
    LinkRow,
    'id' | 'slug' | 'type' | 'destination_url' | 'title' | 'click_count' | 'unique_visitors' | 'status'
  >;
  range: string;
  from: number;
  to: number;
  totals: {
    clicks: number;
    uniques: number;
    clickThrough?: number;
  };
  series: { date: string; label: string; clicks: number; uniques: number }[];
  hourly: { hour: number; label: string; clicks: number }[];
  countries: CategoryCount[];
  devices: CategoryCount[];
  browsers: CategoryCount[];
  os: CategoryCount[];
  referrers: CategoryCount[];
  recent: {
    timestamp: number;
    country: string | null;
    device: string | null;
    browser: string | null;
    os: string | null;
    referrer: string | null;
  }[];
}
