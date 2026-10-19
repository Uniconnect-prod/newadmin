# UNI.SOLUTION Multi-Platform Reporting

API-driven reporting dashboard for subscription/VAS platforms. The reporting application owns the
dashboard, analytics presentation, users and access control; **each registered platform supplies
its data through its own backend API**. The reporting server never connects to a platform's
production database.

- **Frontend** (`client/`): React 19 + Vite, JavaScript, SCSS, React Router 7, Recharts, lucide-react
- **Backend** (`server/`): Node.js (≥ 20) + Express, ES modules
- **Reporting admin database**: MongoDB (users, roles, access windows, platform configuration,
  encrypted API credentials, audit logs, connection history). An in-memory store is available for
  tests and local development.

---

## Contents

1. [Architecture](#architecture)
2. [Local setup](#local-setup)
3. [Environment variables](#environment-variables)
4. [Adding a platform](#adding-a-platform)
5. [Integration engine](#integration-engine)
6. [Reporting rules](#reporting-rules)
7. [Security model](#security-model)
8. [GHSuperWinnings integration status](#ghsuperwinnings-integration-status)
9. [API reference](#api-reference)
10. [Tests](#tests)
11. [Upgrading from the direct-MongoDB version](#upgrading-from-the-direct-mongodb-version)

---

## Architecture

```
Browser (React)                Reporting API (Express)                         Platform APIs
───────────────                ───────────────────────                         ─────────────
 Overview / Reports   ──►  auth ─► platform guard ─► report service ─► connector ──HTTPS──► GHSuperWinnings
 Platforms wizard     ──►  (JWT,   (access window    (metrics,         (auth, params,        /api/admin/dashboard
 Users / Audit        ──►   RBAC)   re-checked per    provenance,       pagination,
                                    request)          exports)          SSRF guard)          Other platform APIs
                                         │                  │
                                         └──── Reporting admin DB (MongoDB) ◄┘
                                               users · roles · access windows · platform configs
                                               encrypted credentials · audit log · connection history
```

Server layout (`server/src`):

| Folder | Responsibility |
|---|---|
| `integrations/` | Generic API connector: SSRF guard, hardened HTTP client, auth strategies, encrypted secret vault, request builder, response normaliser, inspector, validator, presets, adapter registry |
| `reporting/` | Date ranges in the platform timezone, metric resolution with provenance, settlement table, consolidated view, CSV exports |
| `repositories/` | Admin-database access (users, access, platforms, audit, tokens, connection logs, settings) |
| `controllers/`, `routes/` | HTTP layer |
| `middleware/` | Authentication, platform guard, role guard, audit logging, error handling |
| `store/` | MongoDB / in-memory store and reference-data seeding |

Client layout (`client/src`): `layouts/AppShell` (navigation, country/platform context),
`pages/*` (one folder per area), `components/ui` (design system), `components/reports`
(shared report building blocks), `hooks/` (`useApiQuery` with request cancellation,
`useReportFilters` with URL-synced date ranges).

---

## Local setup

```bash
# 1. Backend
cd server
cp .env.example .env        # fill in the values (see below)
npm install
npm run dev                 # http://localhost:5002

# 2. Frontend (separate terminal)
cd client
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :5002)

# Production build of the frontend
npm run build               # → client/dist
```

### Database and administrative operations

```bash
cd server
npm run db:init                 # Initialize fresh relational PostgreSQL database schema
npm run db:migrate              # Run database migrations
npm run setup:superadmin        # Provision or verify the primary Super Admin account
npm test                        # Run automated test suite
```

---

## Environment variables

Server (`server/.env`, see `server/.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | | `production` enforces required secrets and strict CORS |
| `REPORTING_API_PORT` | | API port (default `5002`) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | **yes (prod)** | ≥ 16 random characters each; the server refuses to start in production without them |
| `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | | Default `1h` / `7d` |
| `CORS_ORIGIN` | | Comma-separated browser origins allowed to call the API directly (not needed behind the Vercel `/api` rewrite) |
| `REPORTING_STORE` | | `mongodb` (default) or `memory` (tests/dev only) |
| `REPORTING_MONGODB_URI` | **yes** | Reporting admin database |
| `SEED_SUPER_ADMIN_USERNAME/EMAIL/PASSWORD` | | Creates the first Super Admin **only if no users exist** |
| `INTEGRATION_SECRET_KEY` | **yes** | 32-byte key (base64 or hex) encrypting platform API credentials (AES-256-GCM). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Changing it makes stored credentials unreadable (re-enter them). |
| `OUTBOUND_ALLOWED_HOSTS` | | Approved API hosts, e.g. `ghsuperwinnings.com,*.partner.com`. Super Admins can add more in **Settings → Approved API hosts**. |
| `OUTBOUND_ALLOW_PRIVATE_HOSTS`, `OUTBOUND_ALLOW_HTTP_HOSTS` | | Development-only exceptions (`host:port`) |
| `OUTBOUND_DEFAULT_TIMEOUT_MS`, `OUTBOUND_MAX_RESPONSE_BYTES`, `OUTBOUND_CACHE_TTL_MS` | | Connector tuning (defaults 15 s, 5 MB, 30 s) |
| `EXPORT_MAX_RECORDS`, `EXPORT_MAX_PAGES` | | Export safety limits (defaults 50 000 rows, 500 pages) |

`SOURCE_MONGODB_URI` is **no longer used** and can be removed.

Client: `VITE_API_URL` (optional) — absolute backend URL; leave unset when `/api` is proxied.

---

## Adding a platform

Super Admins only: **Platforms → Add platform**. Every step is a URL (`/platforms/:id?step=…`), so
**API Configuration** and **Data Mapping** in the sidebar link straight into the right step.

1. **Platform details** – name, permanent code, description, logo/brand accent, country, business
   timezone, currency, enabled reporting modules. Optionally start from a preset.
2. **API configuration** – HTTPS base URL (host must be approved), report endpoint path and method
   (GET/POST), optional export endpoint, authentication (none, bearer token, API-key header, or
   username/password login → token from JSON or a documented cookie), write-only credentials,
   timeout, rate limit, response-size limit, default range.
3. **Request parameters** – map `from`, `to`, `report_type`, `page`, `limit`, `offset`, `search`,
   `status`, `cursor` to the platform's parameter names; date format; inclusive/exclusive end date;
   report-type values; pagination strategy and metadata paths; static params; safe extra headers.
4. **Response inspection** – send a test request and see HTTP status, timing, size, content type,
   a sanitised preview (secrets redacted, phone numbers/emails masked), the detected structure
   (click a container to use it as daily rows / records / summary) and pagination metadata.
   Response paths (`data`, `result.rows`, `$` …) are configured explicitly, never guessed.
5. **Field mapping** – map response fields to canonical fields for daily rows, the period summary
   and records, with date formats, decimal separators and column labels; document rules in notes.
6. **Validate & activate** – validation runs against a sample date range and checks destination,
   authentication, parameters, reachability, JSON/success flag, structure, every mapped field,
   number/date parsing, date-range semantics, pagination (two real pages), summary-vs-daily
   reconciliation, record reports and module coverage. **Activation is only possible when the latest
   validation of the saved draft has no failed check** (the result is bound to a hash of the exact
   configuration and credential version).

Activating publishes the configuration: the platform immediately appears in the selector of every
authorised user. Later edits stay in a draft; reports keep using the published configuration until
the draft is validated and published again. **Disable** hides the platform without deleting anything.

Existing platforms from the direct-MongoDB era keep their records but show
*"Previously read directly from MongoDB … configure its API integration"* until configured.

---

## Integration engine

`PlatformApiClient` (`server/src/integrations/connector.js`) is the single, configuration-driven
connector used for every platform:

1. Load the platform's **published** configuration (or the draft, in the wizard).
2. The platform guard has already re-validated the user's access window for this request.
3. Build the outbound request from mapped parameter names, date formats (in the platform timezone)
   and static parameters (`requestBuilder.js`).
4. Decrypt credentials server-side (`secretVault.js`) and resolve auth headers (`authStrategies.js`;
   login tokens are cached in memory and refreshed once on HTTP 401).
5. Check the destination policy, apply the per-platform outbound rate limit, send through the
   hardened client (`httpClient.js`) with timeout, size limit and redirect re-validation.
6. Classify failures (`errors.js`): DNS/connection/TLS, timeout, 401/403, 404, 429 (with
   `Retry-After`), 5xx, invalid JSON/HTML, API-reported failure, schema drift, pagination problems.
7. Normalise with the field mapping (`normalizer.js`): missing → `null`, unparseable → error.
8. Paginate with stall, duplicate and `max_pages` protection; exports report completeness.
9. Cache snapshots for 30 s per platform/config/range; record health (last success/error) and
   failed requests in the connection history — request metadata only.

**Adapters.** All platforms use the `generic-json` adapter. A platform with fundamentally different
semantics (for example raw billing events needing platform-specific aggregation) needs a code-reviewed
adapter registered in `integrations/adapters/index.js` implementing `postNormalize`; configuration
can select an adapter but never supply code.

---

## Reporting rules

- **Provenance on every metric**: `API` (supplied by the platform), `Calculated` (by the reporting
  server from API values, formula shown) or `Unavailable` (missing inputs named). Unavailable is never
  shown as 0.
- An API summary value is always used as-is; derived metrics (e.g. grand total = daily + on-demand)
  are only calculated when the API does not provide them. API totals and recalculated totals are
  never added together; if both exist and differ, a reconciliation warning is shown.
- Point-in-time metrics (subscriber base) are never summed across days or platforms.
- Money is summed exactly (integer micro-units) and rounded half-up at the end.
- Date presets are evaluated in the platform's business timezone; days the API did not return are
  left blank and listed, never zero-filled.
- **All Platforms** (Super Admin): totals only additive flow metrics; revenue per currency; no
  averaging of ratios; failed or unconfigured platforms are excluded and listed.
- Failed requests return an error with a specific code — the UI states that no figures are shown.

---

## Security model

- **SSRF protection**: HTTPS only, approved hosts only, no credentials in URLs, non-standard ports
  must be approved explicitly, every DNS answer checked (loopback, RFC 1918, link-local, CGNAT,
  multicast, reserved, IPv4-mapped/NAT64/6to4 forms and cloud-metadata names blocked), the socket
  connects to the validated address, redirects re-validated per hop, credentials dropped on
  cross-origin redirects, only GET/POST, forbidden headers rejected, endpoint paths confined under
  the base URL, response size enforced after decompression.
- **Secrets**: encrypted at rest (AES-256-GCM), write-only in the UI, never returned by any API,
  redacted from audit metadata and inspection previews.
- **Authentication**: short-lived access tokens; **rotating single-use refresh tokens** with reuse
  detection (reusing a rotated token revokes the whole session family); password changes/resets and
  deactivation revoke sessions; generic login errors and a constant-cost miss path.
- **Authorisation**: Super Admin for platform configuration, approved hosts, users and countries;
  Platform Admin sees users/audit for their platforms only; Analyst/Platform Admin can export;
  Viewer is read-only. The platform header is re-validated against the user's access window on every
  request, so switching platforms client-side cannot bypass access rules.
- **Audit**: logins, failures, token reuse, user changes, exports, platform creation/edits,
  credential changes (field names only), tests, validations, activation and disabling.

---

## GHSuperWinnings integration status

**Observed** (unauthenticated probe on 2026-10-14): `GET https://ghsuperwinnings.com/api/admin/dashboard`
returns `401 {"success":false,"message":"No token provided"}` from an Express backend.

**Inferred from the public GHSuperWinnings admin web client** (not from an authenticated response):
login `POST /api/admin/login` with `{email, password}` → `{success, token}` sent as
`Authorization: Bearer`; dashboard parameters `fromDate`, `toDate`, `report` (`all|success|renewal|churn`),
`page`, `limit` (max 50, or 500 for renewal/churn); response fields `data`, `summary.newSubscriptions`,
`daily[].date`, `daily[].newSubscriptions`; dates bucketed in Africa/Accra.

The **GHSuperWinnings preset** in the wizard contains only these. **Still needed from the API owner**:

1. A service account (or token) for the reporting server, and whether `/api/admin/login` is the intended machine login.
2. A sample authenticated response for `report=all`, `success`, `renewal` and `churn`.
3. The field holding the total record count (`total`, `count`, `pagination.total` or `meta.total`).
4. Whether `toDate` is inclusive and which timezone the API filters in.
5. Which response fields (if any) carry per-day **Activation Parking**, **Super Winnings Daily**
   (offer 9923310010) revenue, **Super Winnings on-demand Daily** (offer 9923310009) revenue,
   **Grand Total**, and the matching transaction counts — these settlement columns are shown as
   "not provided by API" until mapped.
6. Revenue semantics of `totalGhsAmount`, `newRevenueGhs`, `renewalRevenueGhs`, `topupRevenueGhs`
   (gross/net, offers included).
7. Record field names for the amount and a unique record id.
8. Rate limits and any IP allow-listing on their side.

---

## API reference

All routes are under `/api`. Platform-scoped routes take `x-platform-code: <CODE>` (or `ALL` for
Super Admin consolidated views, optionally with `x-country`).

| Method & path | Access | Purpose |
|---|---|---|
| `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | public / user | Sign-in, rotating refresh, sign-out, profile |
| `GET /platforms` | user | Authorised platform selector entries |
| `GET /reports/overview` | platform | KPIs, trends, settlement preview, data source (consolidated for `ALL`) |
| `GET /reports/settlement` | platform | Daily settlement table with totals and running totals |
| `GET /reports/section/:section` | platform | `revenue`, `subscribers`, `renewals`, `churn` |
| `GET /reports/records?reportType=` | platform | Record pages using the source API pagination |
| `GET /reports/activity` | platform | Recent report activity |
| `GET /export/settlement`, `GET /export/records` | Analyst+ | Server-side CSV (`X-Export-Complete`, `X-Export-Rows` headers) |
| `GET/POST /platform-management`, `GET/PUT /platform-management/:id` | Super Admin | Platform registry |
| `PUT /platform-management/:id/integration` | Super Admin | Save draft configuration and credentials |
| `POST /platform-management/:id/inspect` | Super Admin | Test request + sanitised inspection |
| `POST /platform-management/:id/validate` / `activate` / `disable` | Super Admin | Lifecycle |
| `GET /platform-management/history`, `/:id/history` | Super Admin | Connection & validation history |
| `GET/PUT /platform-management/allowlist`, `GET /platform-management/meta` | Super Admin | Approved hosts; wizard metadata and presets |
| `/users`, `/countries`, `/audit-logs`, `/settings` | see roles | Administration |

Query parameters for reports: `range=today|yesterday|7d|30d|mtd|90d|custom`, `from`, `to` (`YYYY-MM-DD`), `fresh=1` to bypass the 30-second cache.

---

## Tests

```bash
cd server
npm test
```

Runs Node's built-in test runner (no network, in-memory store, synthetic mock APIs):

| File | Covers |
|---|---|
| `ssrf-and-http.test.js` | Address classification (IPv4/IPv6/mapped forms), URL policy, DNS-rebinding guard, timeouts, size limits incl. decompression bombs, redirect re-validation, abort |
| `mapping.test.js` | JSON paths, decimal/date transforms, exact money sums, configuration validation, parameter mapping for two platforms, envelopes (`data`/`result`/`payload`/root), missing vs invalid fields |
| `connector.test.js` | Bearer, API-key and login-token auth (incl. re-login on 401), page and offset pagination, stalled pagination, duplicates, max pages, every failure class, empty-vs-failed, outbound rate limit |
| `reporting.test.js` | Provenance, no double counting, stock vs flow metrics, settlement totals and running totals, timezone date presets, CSV escaping/formula injection/precision, GHSuperWinnings regression |
| `api.test.js` | End-to-end over HTTP: login, refresh rotation and reuse detection, activation gating, secrets never returned, host approval, inspection, two live platforms, consolidated rules, failures as errors, record pagination, isolation and expired access, RBAC, CSV exports and audit |

The client has no automated UI tests; it is verified with `npm run build` and manual walkthroughs.

---

## Upgrading from the direct-MongoDB version

1. Set `INTEGRATION_SECRET_KEY` (and keep `JWT_SECRET`/`JWT_REFRESH_SECRET`) on the server host; add
   `ghsuperwinnings.com` to `OUTBOUND_ALLOWED_HOSTS` or approve it in the UI.
2. Deploy. Existing users, roles, access windows and countries are kept. Users sign in again once
   (old refresh tokens have no rotation id).
3. Existing platforms stay registered but show "API integration not activated" until a Super Admin
   configures, validates and activates each one (the GHSuperWinnings preset helps).
4. Make sure the reporting admin cluster has free storage: sign-in now writes refresh-token records.
5. `SOURCE_MONGODB_URI` can be removed; nothing reads the platforms' production databases any more.

Removed as obsolete: the source-database services (`sourceDataService`, `universalAnalyticsEngine`,
`mongoClientManager`), the SQL-emulation layer (`models/db.js`) and its SQL schema/seed scripts, the
Quiz module (its storage was a no-op in the emulation layer), and the hard-coded settlement figures.
