-- ============================================================================
-- link-center — initial schema (Cloudflare D1 / SQLite)
-- Apply with:  wrangler d1 migrations apply link-center-db [--remote|--local]
-- ============================================================================

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ----------------------------------------------------------- sessions ------
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_token   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER
);
CREATE INDEX idx_sessions_user   ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------- campaigns ------
CREATE TABLE campaigns (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_created ON campaigns(created_at DESC);

-- -------------------------------------------------------------- links ------
CREATE TABLE links (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,                 -- 'track' | 'short' | 'landing'
  kind           TEXT NOT NULL DEFAULT 'manual',-- 'manual' | 'email'
  destination_url TEXT NOT NULL,
  title          TEXT,
  description    TEXT,
  button_text    TEXT,                          -- landing
  icon_url       TEXT,                          -- landing
  image_url      TEXT,                          -- landing
  delay_seconds  INTEGER NOT NULL DEFAULT 0,    -- landing
  status         TEXT NOT NULL DEFAULT 'active',-- 'active' | 'disabled' | 'archived'
  owner_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  email_id       TEXT,                          -- set when generated from an email
  expires_at     INTEGER,
  click_count    INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT,                          -- JSON object
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_links_slug    ON links(slug);
CREATE INDEX idx_links_type    ON links(type);
CREATE INDEX idx_links_status  ON links(status);
CREATE INDEX idx_links_campaign ON links(campaign_id);
CREATE INDEX idx_links_owner   ON links(owner_id);
CREATE INDEX idx_links_email   ON links(email_id);
CREATE INDEX idx_links_created ON links(created_at DESC);
CREATE INDEX idx_links_expiry  ON links(expires_at);

-- -------------------------------------------------------- link_events ------
-- Privacy-conscious: no raw IP stored, only a salted hash of (ip + ua) plus
-- coarse-grained derived categories.
CREATE TABLE link_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id      TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  timestamp    INTEGER NOT NULL,
  country      TEXT,
  device       TEXT,
  browser      TEXT,
  os           TEXT,
  referrer     TEXT,
  visitor_hash TEXT,
  email_id     TEXT
);
CREATE INDEX idx_link_events_link_time ON link_events(link_id, timestamp);
CREATE INDEX idx_link_events_time      ON link_events(timestamp);
CREATE INDEX idx_link_events_visitor   ON link_events(visitor_hash, link_id);
CREATE INDEX idx_link_events_email     ON link_events(email_id);

-- ---------------------------------------------------- link_stats_daily -----
-- Fast pre-aggregated time series (one row per link per day).
CREATE TABLE link_stats_daily (
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,          -- 'YYYY-MM-DD' (UTC)
  clicks  INTEGER NOT NULL DEFAULT 0,
  uniques INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, day)
);

-- -------------------------------------------------------------- emails -----
-- Human-readable id like '2026-0814-001' (displayed as #2026-0814-001).
-- group_id: shared UUID for all recipient rows of one send batch, used to
-- associate tracked links with every recipient of the same message.
CREATE TABLE emails (
  id               TEXT PRIMARY KEY,
  group_id         TEXT,
  campaign_id      TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  sender_email     TEXT NOT NULL,
  sender_name      TEXT,
  recipient        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft', -- draft|queued|scheduled|sent|delivered|opened|clicked|hard_bounce|soft_bounce|blocked|invalid|error|deferred|unsubscribed|failed
  brevo_message_id TEXT,
  brevo_batch_id   TEXT,
  scheduled_at     INTEGER,
  sent_at          INTEGER,
  html_content     TEXT,
  text_content     TEXT,
  tags             TEXT,          -- JSON array of strings
  track_links      INTEGER NOT NULL DEFAULT 0,
  reply_to         TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_emails_campaign     ON emails(campaign_id);
CREATE INDEX idx_emails_group        ON emails(group_id);
CREATE INDEX idx_emails_brevo_msg    ON emails(brevo_message_id);
CREATE INDEX idx_emails_status       ON emails(status);
CREATE INDEX idx_emails_created      ON emails(created_at DESC);
CREATE INDEX idx_emails_recipient    ON emails(recipient);

-- ------------------------------------------------------- email_events ------
-- payload_hash = SHA-256 of the raw webhook payload -> idempotency/replay
-- protection (UNIQUE constraint rejects duplicate deliveries).
CREATE TABLE email_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id        TEXT REFERENCES emails(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  payload_hash    TEXT NOT NULL UNIQUE,
  link_id         TEXT,
  url             TEXT,
  ip              TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_email_events_email ON email_events(email_id, event_timestamp);
CREATE INDEX idx_email_events_type  ON email_events(event_type, event_timestamp);

-- ----------------------------------------------------------- settings ------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
