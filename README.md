# Link Center — Link & Email Control Center

A production-ready **link management + click tracking + transactional email control center**
built on Cloudflare Workers, D1, KV and the Brevo API.

Hosted at: `https://link.ankb.qzz.io`

```
/track/Kx8pQ2mL9A   → tracked redirect (clicks, uniques, countries, devices, …)
/r/abc123           → direct short redirect (still counted)
/go/abc123          → lightweight landing page with optional delay
/dashboard          → admin dashboard (dark UI, charts, command palette)
/api/*              → authenticated JSON API
/api/webhooks/brevo → Brevo transactional webhook endpoint
```

---

## Architecture

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, **zero runtime dependencies**) |
| Database | Cloudflare D1 (SQLite) with migrations in `./migrations` |
| Cache / rate limits / unique visitors | Cloudflare KV |
| Email | Brevo transactional API (`POST /v3/smtp/email`), server-side only |
| Email events | Brevo transactional webhooks → `email_events` table (idempotent) |
| Frontend | Single-page app (vanilla JS + SVG charts), served by the Worker (~46 KiB gzipped total) |
| Auth | PBKDF2-SHA256 (WebCrypto), D1 sessions, HttpOnly cookies, per-session CSRF tokens |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` (real D1/KV in-memory) |

The Brevo API key **never** reaches the browser — every Brevo call happens
server-side with the `api-key` header, and only `/api/*` responses are sent to
the dashboard.

### Link-type engine (extensible)

Public links are handled by a small registry (`src/link-types/registry.ts`).
Each type is a `(path, handler)` pair; adding a new type (e.g. `/file/:id`,
`/invite/:id`, `/download/:id`) is a single registration — the router and
dashboard require no changes:

```ts
registerLinkType({
  type: 'file',
  path: '/file/:id',
  handle: async ({ link }) => redirect(link.destination_url),
});
```

### Privacy-conscious analytics

- Raw IP addresses are **never stored**. A salted SHA-256 fingerprint
  (`CLICK_SALT` secret) of `ip + user-agent + day` is used only to count
  unique visitors.
- Stored fields are coarse categories: country (`CF-IPCountry`), device,
  browser, OS, referrer hostname.
- Click events are pruned after the configured retention window; aggregate
  counters and daily series (`link_stats_daily`) are kept.
- `Referrer-Policy: no-referrer` on all responses.

---

## Repository layout

```
migrations/0001_init.sql   D1 schema (users, sessions, links, link_events,
                           link_stats_daily, campaigns, emails, email_events, settings)
src/index.ts               Worker entry: routing + security middleware
src/config.ts              Env config with defaults
src/types.ts               Shared types
src/lib/                   http, slug, validate, password, session, csrf,
                           ratelimit, brevo (client), webhook (verify),
                           click (pipeline), analytics, events,
                           db-links, db-campaigns, db-emails, mail-send,
                           link-rewrite (email → tracked links), settings, ua
src/link-types/            registry + built-in handlers (track/short/landing)
src/routes/                router, public, api, auth-routes, webhook, pages, helpers
src/dashboard/assets.ts    CSS/JS bundled as raw text (wrangler module rules)
public/assets/             styles.css + app.js (SPA source of truth)
test/                      vitest + cloudflare pool tests (72 tests)
wrangler.toml              Worker config, D1/KV bindings, custom domain
.env.example               Secret inventory (never commit real values)
```

---

## Deployment

### 1. Prerequisites

- A Cloudflare account with `link.ankb.qzz.io` on a zone you control.
- A Brevo account with an API key (`Settings → API Keys`).
- Node 20+ (uses `wrangler`, `vitest`).

### 2. Create resources & configure

The D1 database and KV namespace are **auto-provisioned** on first deploy
(IDs are intentionally blank in `wrangler.toml`). To create them manually
instead — from the Cloudflare dashboard, no CLI needed — paste the IDs into
`wrangler.toml`:

```bash
npm install

# Optional: create resources yourself and pin their IDs in wrangler.toml
#   Dashboard → Workers & Pages → D1 → Create database ("link-center-db")
#   Dashboard → Workers & Pages → KV → Create namespace ("KV")
#   then add database_id / id to wrangler.toml.

# Apply the schema (after the first deploy):
npx wrangler d1 migrations apply link-center-db --remote

# Secrets (NEVER commit these):
npx wrangler secret put BREVO_API_KEY        # xkeysib-...
npx wrangler secret put BREVO_SENDER_EMAIL  # no-reply@link.ankb.qzz.io
npx wrangler secret put BREVO_SENDER_NAME   # Link Center
npx wrangler secret put BREVO_WEBHOOK_SECRET # openssl rand -hex 32
npx wrangler secret put CLICK_SALT           # openssl rand -hex 32
npx wrangler secret put SETUP_TOKEN          # optional first-run hardening
```

`wrangler.toml` already maps the custom domain:

```toml
[[routes]]
pattern = "link.ankb.qzz.io"
custom_domain = true
```

### 3. Deploy

Deploy from your machine:

```bash
npx wrangler deploy
```

Or via the **Cloudflare dashboard Git integration** (Workers Builds / Pages):
make sure the build runs against the branch that contains `wrangler.toml`
(merge this PR into `main` first), with build command `npx wrangler deploy`.
Cloudflare runs the command in its own cloud build environment — you do not
need wrangler installed locally.

### 4. First-run setup

Open `https://link.ankb.qzz.io/setup` and create the admin account
(min. 10-char password). If `SETUP_TOKEN` is set, the form also asks for it.
Afterwards `/setup` returns 404.

### 5. Configure Brevo

1. **Sender** — verified sender domain/address in Brevo; set the default in
   `Dashboard → Settings → Brevo`.
2. **Webhook** — in Brevo: `Settings → Transactional emails → Webhook`:

   ```
   URL:    https://link.ankb.qzz.io/api/webhooks/brevo?secret=<BREVO_WEBHOOK_SECRET>
   Events: sent, delivered, opened, click, softBounce, hardBounce, blocked,
           spam, invalid, deferred, unsubscribed
   ```

   The Worker also accepts the secret via `X-Webhook-Auth-Token` header,
   `Authorization: Bearer …` or Brevo's Basic/Token webhook auth
   (Brevo does not sign webhook payloads — see `src/lib/webhook.ts`).

### Local development

```bash
npm run dev          # wrangler dev on http://127.0.0.1:8787
npm test             # 72 tests (vitest + cloudflare pool)
npm run check        # tsc --noEmit
npm run lint         # eslint
npm run build        # wrangler deploy --dry-run
```

For local dev secrets, create `.dev.vars` (git-ignored) with the same keys as
`.env.example`.

---

## Routes

### Public (lightweight, no auth)

| Route | Behavior |
|---|---|
| `GET /track/:id` | validate → record click → `302` to destination |
| `GET /r/:id` | record click → `302` to destination |
| `GET /go/:id` | landing page (title/description/button/icon/image/delay) + click |
| `GET /healthz` | liveness probe |
| `GET /robots.txt` | disallow all |

Disabled → friendly *"This link is disabled"* page; expired → *"This link has
expired"*; unknown → 404. Non-http(s) destinations (`javascript:`, `data:`,
…) are rejected at creation time.

### Dashboard (`/dashboard`, auth required)

`/dashboard` (Overview) · `/dashboard/links` · `/dashboard/links/:id/analytics`
· `/dashboard/campaigns` · `/dashboard/campaigns/:id` · `/dashboard/mail`
(compose) · `/dashboard/mail/history` · `/dashboard/mail/:id` ·
`/dashboard/analytics` (global) · `/dashboard/settings`

### API (JSON envelope: `{ success, data }` / `{ success, error: { code, message } }`)

```
GET    /api/overview
GET    /api/analytics?range=24h|7d|30d|all
GET    /api/links?search=&type=&status=&campaignId=&sort=&page=&perPage=
GET    /api/links/:id
POST   /api/links
PUT    /api/links/:id
DELETE /api/links/:id
POST   /api/links/:id/duplicate
POST   /api/links/:id/toggle
GET    /api/links/:id/analytics?range=&from=&to=
GET    /api/campaigns          POST /api/campaigns
GET    /api/campaigns/:id      PUT /api/campaigns/:id      DELETE /api/campaigns/:id
POST   /api/mail/drafts        (save draft)
POST   /api/mail/preview       (save draft + render with tracked links)
POST   /api/mail/send          (send now or scheduledAt)
POST   /api/mail/test          (send test copy)
GET    /api/mail/history?status=&search=&page=
GET    /api/mail/:id           DELETE /api/mail/:id (drafts only)
GET    /api/settings           PUT /api/settings
GET    /api/settings/brevo/status
GET    /api/auth/me            POST /api/auth/login   POST /api/auth/logout
POST   /api/webhooks/brevo     (Brevo events; verified)
```

### Email → tracked links

When composing with **Track links** enabled, every http(s) URL in the HTML
and plain-text body is rewritten into `/track/:slug` and a `track` link row is
created and associated with the email/campaign. Clicks on those links are
recorded normally, so the dashboard shows the full funnel:

```
Campaign: School Update
  Email:  #2026-0814-001   (sent 100 → delivered 98 → opened 76 → clicked 31 → bounced 2)
  Tracked URL: /track/Kx8pQ2mL9A  (31 clicks)
```

---

## Security

- **Secrets** — all in Cloudflare secrets; `BREVO_API_KEY` never leaves the
  Worker. Settings screens show only a masked key (`••••…abcd`).
- **Auth** — PBKDF2-SHA256 (100k iterations) password hashing; sessions stored
  as SHA-256 hashes in D1; `HttpOnly; SameSite=Lax; Secure` cookies.
- **CSRF** — per-session token required in `X-CSRF-Token` for every mutation,
  plus same-origin validation.
- **Rate limiting** — login (per IP, KV-backed, default 10/5 min), mail
  sending (200/user/hour, 300/IP/hour), general API abuse (300/min/IP).
- **Input validation** — strict slug rules (reserved routes like `admin`,
  `api`, `track`, `assets`… are rejected), email validation, destination URL
  scheme allow-list (http/https only), size limits.
- **Webhooks** — shared-secret verification, `UNIQUE(payload_hash)` replay
  protection, batched payloads supported.
- **Headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS, CSP on the
  dashboard (`default-src 'self'`, no inline scripts).
- **Output** — all user content escaped when rendered in public pages.

## Operations notes

- Link lookup on the public path is KV-cached (60 s TTL) and invalidated on
  writes; the click counter is a single synchronous `UPDATE`, while event
  rows, unique-visitor counting and daily aggregates run in
  `ctx.waitUntil` so redirects stay fast.
- Analytics time series come from the pre-aggregated `link_stats_daily`
  table; breakdowns use indexed `link_events` GROUP BY queries.
- Drafts and their tracked links can be deleted from Mail History; scheduled
  emails must be cancelled in Brevo (the API refuses to delete them).
- Click-event retention is enforced probabilistically (≈1% of clicks) to keep
  the click path free of maintenance queries.

## Tests

```bash
npm test
```

72 tests across 4 files — slug generation/validation, link CRUD + redirects
(disabled/expired/malformed), unique visitors, analytics, campaigns, compose
validation, drafts/preview, Brevo send success/failure/scheduling, webhook
verification + idempotency + batched payloads, auth, CSRF, origin checks,
rate limiting, XSS escaping, security headers, static assets.

## Environment variables & secrets

| Name | Required | Purpose |
|---|---|---|
| `BREVO_API_KEY` | for email | Brevo API key (server-side only) |
| `BREVO_SENDER_EMAIL` | for email | Default sender address |
| `BREVO_SENDER_NAME` | optional | Default sender name |
| `BREVO_WEBHOOK_SECRET` | for events | Shared webhook secret |
| `CLICK_SALT` | recommended | Salt for visitor fingerprints |
| `SETUP_TOKEN` | optional | Hardens first-run `/setup` |
| `APP_URL` | var | Public base URL (link.ankb.qzz.io) |
| `SESSION_DAYS`, `LOGIN_RATE_LIMIT`, `API_RATE_LIMIT`, … | vars | Tunables, see `wrangler.toml` |

## License

MIT — see `LICENSE`.
