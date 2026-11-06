# jobi — Design Document

> Status: design of record (pre-implementation). No application code has been written yet.
> Last updated: 2026-11-06

---

## 1. Mission & purpose

jobi helps job-seekers — primarily new grads and interns firing off high volumes of applications — **keep track of every application so they never miss an interview, OA, recruiter email, or rejection.**

The twist: **Notion is the frontend.** jobi assumes the user already lives in Notion for their daily workflow. jobi connects to their Notion, provisions a job-tracking database, and keeps it populated automatically from their email. jobi itself is invisible plumbing with a thin config/health surface.

**Why not just do this in Notion directly?** AI classification inside Notion is a paid feature and not available on the student plan. jobi moves the AI classification + extraction to Cloudflare's free tier, so the whole thing stays effectively free for low-volume personal use.

**What the author wants from it:** a portfolio-grade project and a tool they personally need, that others can benefit from. Must be effectively free to run.

### Non-goals (v1)
- No sharing / collaboration / teams.
- No browser extension.
- No auto-scraping of job boards.
- No in-app job list (Notion is that view).
- This is a job tracker only.

---

## 2. Product shape

jobi is an **email-driven ETL pipeline**, not a CRUD app:

```
user's inbox  ──forward──▶  jobi (classify + extract)  ──▶  user's Notion database
```

The user forwards job-related emails from their own email client. jobi identifies the user, classifies the email (job-related? which stage?), extracts structured fields, and upserts a row into that user's Notion database.

---

## 3. Key decisions (resolved during design)

| # | Decision | Choice |
|---|----------|--------|
| 1 | What is the product | Email → classify → Notion pipeline; Notion is the UI |
| 2 | Target user | New grad / intern, high application volume |
| 3 | Notion's role | Source of truth / frontend; jobi provisions & writes into it |
| 4 | Business model | Free; portfolio + personal use |
| 5 | Login | **Notion OAuth is the login** (no separate account system) |
| 6 | User identification on inbound | **Match the user's own forwarding address** (manually forwarded mail's envelope `From`). No per-user aliases. |
| 7 | Forwarding-address trust | **No email confirmation step** (cut for v1). Trust-on-claim, first-claim-wins, optionally gated by inbound SPF/DKIM pass. |
| 8 | Many forwarding addresses per user | Yes (work + personal) |
| 9 | Classification model | **Clef (`clef-omni`) decision model** for the job-related / stage decision |
| 10 | Extraction model | **Gemma** for structured field extraction (reused from notion-scripts) |
| 11 | Keyword gating | **No hard gate in v1.** Classify everything forwarded; instrument to learn the keyword/stage distribution for the future. |
| 12 | Notion DB provisioning | `@notionhq/client` `databases.create` at runtime with the user's OAuth token. **Not** Notion-as-Code (see §9). |
| 13 | Web app scope | Thin: connect Notion, manage forwarding addresses, show forwarding setup, sync health |

---

## 4. Architecture overview

```
                 ┌─────────────────────────────────────────────────────────┐
                 │                   Cloudflare Worker                       │
                 │                                                           │
  Browser ──────▶│  fetch handler  ──▶  TanStack Start (SSR React app)       │
  (OAuth, config)│                 └─▶  Hono /api/* (OAuth, config, health)  │
                 │                                                           │
  Inbound email ▶│  email handler  ──▶  resolve user ──▶ enqueue             │
  (forwarded)    │                                                           │
                 │  queue consumer ──▶ classify ──▶ extract ──▶ sync ──▶ log │
                 └───────┬───────────────┬──────────────┬─────────────┬──────┘
                         │               │              │             │
                       D1 (tenant     KV (Notion     Workers AI    Notion API
                       data, events,  tokens,        (clef-omni,   (per-user
                       learning)      transient)     gemma)        OAuth token)
```

### Cloudflare services
| Service | Role |
|---------|------|
| Workers | API + SSR host; email handler; queue consumer |
| D1 | Multi-tenant relational data, email event log, learning tables |
| KV | Per-user Notion access tokens; transient OAuth state |
| Queues | Buffer between email intake and processing; retries; paces Notion ~3 req/s |
| Workers AI | `clef-omni` (classify), `gemma` (extract) |
| Email Routing | Inbound mail → Worker `email()` handler (single shared address) |
| Secrets | Notion OAuth client secret |

---

## 5. The pipeline, step by step

### 5.1 Inbound (Worker `email()` handler)
1. Receive forwarded email on the shared inbound address.
2. **Resolve user:** look up envelope `From` in `forwarding_addresses`. Unknown → drop.
3. (Optional hardening) drop if inbound SPF/DKIM fails.
4. Reject oversized mail (reuse notion-scripts' 5 MB guard).
5. Parse with `postal-mime`.
6. **Dedupe:** compute `message_hash`; if `(user_id, message_hash)` already in `email_events`, skip.
7. Enqueue `{ user_id, parsed email fields }` to the Queue. Return fast.

### 5.2 Queue consumer
1. **Classify** with `clef-omni`: decision schema = `{ job_related: bool, stage: applied|oa|interview|offer|rejected|not_job }`. Returns per-option probabilities.
2. If not job-related → record event as `skipped`, still update learning tables, stop.
3. **Extract** with Gemma into the existing `ExtractionResult` JSON schema (company, position, status, contacts, dates, applicationId).
4. **Instrument:** update stage-aware `term_stage_counts` and `sender_domain_stage_counts`.
5. **Sync to Notion** (per-user token + per-user data source): `findExisting` → `pages.update` or `pages.create`, then append correspondence toggle block (reuse notion-scripts logic).
6. **Record** `email_events` row (`processed` / `failed`, `notion_page_id`, error).
7. On transient Notion 429/5xx → let the Queue retry with backoff.

### 5.3 Why a Queue (not inline)
The email handler must ack fast and can't block on two AI calls + several Notion round-trips. The Queue gives retries on transient Notion failures and lets jobi throttle to Notion's ~3 req/s limit. If the sync step later becomes genuinely multi-step per email, graduate it to a Cloudflare Workflow; a Queue is the right v1 choice.

---

## 6. Data model (D1, multi-tenant, scoped by `user_id`)

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,           -- jobi uuid
  notion_user_id TEXT UNIQUE NOT NULL,       -- from OAuth
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notion_connections (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  workspace_id   TEXT NOT NULL,
  bot_id         TEXT,
  database_id    TEXT,                        -- provisioned target DB
  data_source_id TEXT,                        -- carries schema + rows (API 2025-09-03+)
  property_ids   TEXT,                        -- JSON: jobi prop name -> Notion property id
  status         TEXT NOT NULL DEFAULT 'connected',
  provisioned_at TEXT
);

-- forwarding addresses: identify the user AND gate processing
CREATE TABLE forwarding_addresses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id),
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(address)                             -- one owner per address, first-claim wins
);

-- idempotency + audit for every processed email
CREATE TABLE email_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL REFERENCES users(id),
  message_hash   TEXT NOT NULL,
  from_email     TEXT,
  subject        TEXT,
  classification TEXT,                         -- stage | not_job_related
  notion_page_id TEXT,
  status         TEXT NOT NULL,                -- processed | skipped | failed
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, message_hash)
);

-- stage-aware learning (upgrade of notion-scripts term_counts)
CREATE TABLE term_stage_counts (
  term       TEXT NOT NULL,
  stage      TEXT NOT NULL,
  doc_count  INTEGER NOT NULL DEFAULT 0,
  term_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, stage)
);

CREATE TABLE sender_domain_stage_counts (
  domain    TEXT NOT NULL,
  stage     TEXT NOT NULL,
  doc_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, stage)
);
```

Key change from notion-scripts: the hardcoded `DATABASE_ID` / `DATA_SOURCE_ID` constants become per-user rows in `notion_connections`.

---

## 7. Notion schema (the provisioned database)

Defined once in TypeScript as `JOBI_SCHEMA`, applied per-user at runtime. Properties (from notion-scripts' working sync):

| Property | Type |
|----------|------|
| title | title (`"Company - Position [- applicationId]"`) |
| company | rich_text |
| position | rich_text |
| status | select — `applied, online assessment, phone screen, interview, offer, accepted, rejected` |
| application date | date |
| from email | email |
| application id | rich_text |
| contact name | rich_text |
| contact email | email |
| oa deadline date | date |
| interview date | date |

Each application page also gets a **correspondence toggle block** per email (date + subject → quoted body), reused from notion-scripts' `buildCorrespondenceBlocks`.

---

## 8. Classification + extraction (the AI split)

- **Classify → `clef-omni`.** A decision model: give it the email as "state" plus a typed-question schema, it returns a probability per allowed option. Used for the constrained `job_related` / `stage` decision. Bills input tokens only (no output-token charge), which keeps the classify step cheap.
- **Extract → Gemma.** Free-form structured extraction into the existing `ExtractionResult` schema (`extract.ts`). Reused largely as-is, including retry/backoff.
- Both run on Workers AI's 10,000 free Neurons/day — effectively free at personal volume.

> Implementation note: the exact `env.AI.run("clef-omni", …)` request shape must be pinned against the model page + `wrangler types` during implementation; the public docs page is light on the request schema.

---

## 9. Provisioning: why NOT Notion as Code

**Notion as Code** (the `ntn` CLI + `POST /v1/infra_as_code` async API) lets you describe a workspace declaratively in TypeScript and apply it, with a persisted `resourceId → record` mapping so re-applies update in place. It's genuinely nice tech, but it's the **wrong tool for jobi's per-user runtime provisioning**:

1. **Requires personal access tokens, not OAuth bot tokens.** The docs state Notion as Code requires PATs. jobi authenticates each user via public OAuth, which issues bot tokens; there's no way to obtain a PAT per end-user through OAuth. **Dealbreaker.**
2. **Alpha, acceptance-gated, breaking changes expected.** Not something to put on a product's critical onboarding path.
3. **Rate limit 5 req/min** — hostile for per-signup provisioning bursts.
4. Async task + poll + mapping persistence adds complexity vs. a synchronous `databases.create`.

**What jobi does instead:** `@notionhq/client` → `databases.create` with the user's OAuth bot token, synchronously, inside the Worker right after OAuth completes. This is first-party, GA, and works with the token type jobi actually has. Notion's own "Preparing your connection for users" guide confirms public connections can create the databases/pages they need right after authorization.

**The idea worth stealing from Notion as Code:** declarative, re-appliable schema with a persisted ID mapping. jobi mirrors this pattern natively:
- `JOBI_SCHEMA` is the single declarative source of truth for properties.
- The returned `database_id` / `data_source_id` / property IDs are persisted in `notion_connections` (jobi's equivalent of the resourceId → record mapping).
- A `reconcileSchema()` can patch missing properties via `databases.update` on later runs — same "describe desired state, update in place" philosophy.

**Future consideration:** if Notion as Code graduates to GA *and* supports OAuth tokens, it could replace the provisioning internals. Tracked as nice-to-have, not planned.

### Notion API version note (2025-09-03+)
Under the current API, a **database** contains one or more **data sources**, and the **data source** carries the property schema and the rows (pages) — not the database. `databases.create` creates the DB + its `initial_data_source` in one call and returns both IDs. Pages are created with `parent: { type: "data_source_id", data_source_id }`. This matches notion-scripts' existing `DATA_SOURCE_ID` usage.

---

## 10. Auth & secrets

- **Login = Notion OAuth** (public integration). The OAuth grant provides the access (bot) token + workspace identity; the jobi user row is keyed off Notion's user identity.
- **Notion OAuth client secret** → Workers Secret (one app-level secret). Must be moved out of `.dev.vars` for production.
- **Per-user Notion access tokens** → KV, keyed by `user_id`. (Not in D1.)
- **OAuth state / PKCE** → short-TTL KV entries.

---

## 11. Email intake & trust model

- Inbound via Cloudflare Email Routing to a single shared address (e.g. `inbound@<domain>`). Confirmed the domain routes mail to Cloudflare.
- **User identified by their own forwarding address** (manual forward's envelope `From`), looked up in `forwarding_addresses`.
- **No confirmation step** (cut for v1). Trust-on-claim; `UNIQUE(address)` → first-claim-wins.
- **Accepted risk:** without verification, a spoofed `From` could inject a row into a user's Notion. Low stakes for a personal tracker. Cheap mitigation with no outbound email: drop inbound messages that fail SPF/DKIM (Email Routing exposes auth results). Kept as a guardrail.

---

## 12. Web app (thin config surface)

The stubbed `src/routes/index.tsx` becomes a dashboard:
- Connect / disconnect Notion (OAuth).
- Pick/confirm the provisioned database's parent page.
- Add / remove forwarding addresses.
- Show forwarding-setup instructions (which address to forward to; optional suggested filter rules).
- Sync health: recent `email_events`, failures, re-sync button.

No in-app job list — Notion is the view.

---

## 13. Code reuse from `notion-scripts` (sibling project)

`notion-scripts` is the working single-tenant prototype of the engine. jobi multi-tenant-izes it.

| Reuse ~as-is | Must change for multi-tenant |
|---|---|
| `extract.ts` (schema, statuses, prompt, parse) | `notion.ts` — client built from **per-user token**, not one env key |
| `job-applications.ts` dedupe/`findExisting`, correspondence toggle blocks | hardcoded `DATABASE_ID` / `DATA_SOURCE_ID` → per-user lookup |
| `postal-mime` parsing; AI retry/backoff | classify step → swap to `clef-omni` |
| logging / observability patterns | add user-resolution + `email_events` idempotency |
| `term_counts` / `sender_domains` concept | upgrade to **stage-aware** tables |

---

## 14. Build plan (incremental, digestible slices)

Each slice is independently testable and leaves the app in a working state.

### Slice 0 — Project cleanup & bindings
- Replace the template `Task` model/endpoints with jobi's domain.
- Add bindings to `wrangler.jsonc`: KV namespace, Queue (producer + consumer), Workers AI, keep D1.
- Run `wrangler types` after binding changes.
- Rewrite `README.md` to describe jobi (currently leftover template boilerplate).
- **Verify:** `bun run build` clean; `wrangler types` regenerated.

### Slice 1 — Multi-tenant D1 schema
- Author Prisma schema (or raw SQL migrations) for §6 tables.
- Generate migration; apply locally.
- **Verify:** migration applies; generated client typechecks.

### Slice 2 — Notion OAuth + login
- Register public integration; store client secret as a Worker Secret.
- Implement OAuth start + callback routes (PKCE, state in KV).
- On callback: upsert `users`, store bot token in KV, create `notion_connections` row.
- **Verify:** full OAuth round-trip locally; token in KV; user row created.

### Slice 3 — Database provisioning
- Define `JOBI_SCHEMA` (§7).
- `provisionDatabase(notion, parentPageId)` → `databases.create`; persist `database_id` / `data_source_id` / `property_ids`.
- `reconcileSchema()` to patch missing props.
- **Verify:** new DB appears in a test Notion workspace with correct props; re-run updates in place, no duplicate.

### Slice 4 — Email intake + user resolution
- Email Routing → Worker `email()` handler.
- Resolve user via `forwarding_addresses`; dedupe via `email_events`; parse; enqueue.
- (Optional) SPF/DKIM drop.
- **Verify:** forwarded test email resolves to the right user and lands on the Queue; unknown sender dropped.

### Slice 5 — Classify + extract (queue consumer)
- Consumer: `clef-omni` classify → Gemma extract.
- Port `extract.ts`; swap classification to clef.
- Update learning tables.
- **Verify:** sample job emails classify to the right stage; extraction matches schema; non-job mail skipped.

### Slice 6 — Notion sync
- Port `job-applications.ts` with per-user token + data source.
- Upsert page + correspondence block; write `email_events`.
- Queue retry/backoff on Notion 429/5xx.
- **Verify:** end-to-end — forward an email, row appears/updates in the user's Notion; idempotent on re-forward.

### Slice 7 — Web dashboard
- Build §12 dashboard on `src/routes/`.
- Forwarding addresses CRUD; connection status; recent events; re-sync.
- **Verify:** manage a connection and addresses from the UI; health reflects real events.

### Slice 8 — Hardening & observability
- Error capture (notion-scripts has a PostHog pattern — optional).
- Rate-limit pacing to Notion; dead-letter handling on the Queue.
- **Verify:** simulated Notion 429 retries without data loss.

---

## 15. Libraries & external APIs

### npm libraries
| Library | Purpose | Source |
|---|---|---|
| `hono` | API routing (already present) | existing |
| `chanfana` | OpenAPI on Hono (present; keep or drop) | existing |
| `@tanstack/react-start`, `@tanstack/react-router` | SSR React web app | existing |
| `@notionhq/client` | Notion API client (OAuth token exchange, `databases.create`, pages/blocks). Supports API 2025-09-03 / 2026-03-11. | add (from notion-scripts) |
| `postal-mime` | Parse inbound MIME email | add (from notion-scripts) |
| `@prisma/client` + `@prisma/adapter-d1` | D1 access | existing (`packages/db`) |
| `zod` | Schema validation | existing |
| `stopword` | Keyword tokenization for learning tables | add (from notion-scripts) |

### External APIs
| API | Use | Auth |
|---|---|---|
| Notion REST API | OAuth, provision DB, upsert pages/blocks, query data source | Per-user OAuth bot token |
| Cloudflare Workers AI | `clef-omni` classify, `gemma` extract | `AI` binding |
| Cloudflare Email Routing | Inbound email → Worker | Platform binding |

---

## 16. Documentation consulted

Cloudflare:
- Workers AI pricing (10k free Neurons/day): https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI text-classification / decision models (`clef-omni`): https://developers.cloudflare.com/workers-ai/models/text-classification/ and https://developers.cloudflare.com/workers-ai/models/clef-omni/
- Clef announcement: https://blog.cloudflare.com/clef-decision-models/
- Durable Objects "Rules of" + pricing/limits (evaluated, not used for data): https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects
- D1 limits / pricing / Free-plan row caps (Sep 2026): https://developers.cloudflare.com/d1/platform/limits , https://developers.cloudflare.com/changelog/product/d1/
- Queues vs Workflows guidance: https://community.cloudflare.com/t/workers-new-best-practices-guide-for-workers/893896
- Cron Triggers (future reconciliation): https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Email Routing Worker `email()` handler + auth (SPF/DKIM): https://developers.cloudflare.com/email-service/api/route-emails/email-handler/ , https://developers.cloudflare.com/email-service/concepts/email-authentication/
- KV for auth tokens: https://developers.cloudflare.com/kv/get-started
- Workers Secrets: https://developers.cloudflare.com/workers/runtime-apis/bindings/secrets

Notion:
- Public OAuth integration overview: https://developers.notion.com/guides/connections-and-tokens/public-integrations/overview
- Preparing your connection for users (provision after auth): https://developers.notion.com/guides/get-started/preparing-for-users
- API 2025-09-03 upgrade guide (data sources): https://developers.notion.com/docs/upgrade-guide-2025-09-03
- Create a database / create a data source / create pages in a data source: https://developers.notion.com/reference/database-create , https://developers.notion.com/reference/create-a-data-source , https://developers.notion.com/guides/data-apis/create-pages-in-a-data-source
- `@notionhq/client` SDK: https://github.com/makenotion/notion-sdk-js
- Notion as Code (evaluated, not used): https://github.com/makenotion/notion-as-code-template and the beta "How to use Notion as Code" guide
- Notion API request limits (~3 req/s): https://developers.notion.com/reference/request-limits

### Compliance note
External source content referenced in this document was paraphrased/summarized for compliance with licensing restrictions; see the linked sources for originals.

---

## 17. Open items to resolve during implementation

1. **`clef-omni` exact binding request schema** — pin against the model page + `wrangler types`.
2. **SPF/DKIM field access** in the Email Routing `email()` message — confirm exact header/API.
3. **Keyword list ownership** — v1 is no-gate + instrument; revisit a data-driven forwarding filter once learning tables show signal.
4. **chanfana** — decide whether to keep OpenAPI tooling or drop it for the thin internal API.
5. **PostHog observability** — optional port from notion-scripts; decide if it's in scope for v1.
