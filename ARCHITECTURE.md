# Job Platform — Architecture & Vision

## Vision

A job hunting pipeline that automatically aggregates postings from multiple sources, scores them against configurable role profiles, and gives a clean front-end to review, apply, and track applications.

Cross-repo orchestration (scraper cadence, resume-bot block pipeline, link-tailored resumes) is planned in `hadoku_site/docs/planning/job-search-orchestration.md`.

### Roadmap

| Phase                          | Status    | Scope                                                                                                                                                                                                              |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **V1 — Scrape & Display**      | Shipped   | User subscribes to companies → scraper fetches → ingest → score → browsable UI                                                                                                                                     |
| **V2 — Triage State**          | Shipped   | Per-job, per-user lifecycle: `interested / dismissed / saved / applied / offered / rejected`. Prevents re-evaluating the same jobs. Prereq for V4/V5.                                                              |
| **V3 — Tailored Applications** | Shipped   | Per-job tailored resume + cover letter via resume-bot (service binding from jobplatform-api)                                                                                                                       |
| **V4 — Auto Apply**            | In review | Approve-to-apply queue + PC-side form runner with Ashby / Greenhouse / Lever adapters. Fills and screenshots today; **nothing has been submitted yet**. LinkedIn is out of scope (account flagged for automation). |
| **V5 — Tracking & Follow-ups** | Deferred  | Timeline per application, notes, follow-up dates, Kanban across in-flight pipelines. Extends V2 state table.                                                                                                       |
| **V6 — Alerts & Digest**       | Deferred  | Daily email / push when new jobs score above per-profile threshold. Uses V2 state to suppress already-triaged.                                                                                                     |

---

## System Architecture

End-to-end pipeline (as shipped — scrape-directive pull model):

```
User adds a confirmed (ats, slug) to a profile in the jobplatform UI
  ↓
POST /jobplatform/api/profiles/:id/companies  (this worker)
  │  writes a profile_companies row. NO scraper call — companies are a
  │  directive the scraper pulls, not a target we push.
  ↓
GET /jobplatform/api/directives  (this worker, scraper reads it)
  │  the union of every profile's companies + keywords
  ↓
hadoku-scrape (Python FastAPI, sibling repo)
  │  resolves company → (ats, slug) via cache / mechanical / alias / optional LLM
  │  registers targets in its own registry, then scrapes them
  │  scheduled (or on-demand) POST /api/v1/jobboards/search
  │  enumerates active targets: Greenhouse, Lever, LinkedIn (Ashby resolver-only)
  │  writes each listing to Cloudflare KV: jobplatform:raw:{source}_{id}
  │  POSTs batches of 25 to /jobplatform/api/ingest with FULL jobs inline
  ↓
POST /jobplatform/api/ingest  (this worker)
  │  reads jobs from webhook body (NOT from KV — KV is archival only)
  │  dedups by URL, classifies (role_track, role_level), parses (ats, slug)
  │  inserts into D1 jobs
  ↓
@wolffm/jobplatform-worker (Hono, this repo)
  │  reads D1 for filtered job lists
  │  SCORES ON READ, per request — the precomputed job_profile_matches
  │  table was dropped in migration 0008, so a score always reflects the
  │  profile as it is now
  │  exposes REST API under /jobplatform/api
  ↓
@wolffm/jobplatform (React, this repo)
  │  profile sidebar + per-profile job browser
  │  job detail drawer + action panel
  │  mounts in hadoku_site
  ↓
hadoku_site
  └── routes /jobplatform/api/* → Cloudflare Worker (hadoku_site/workers/jobplatform-api/)
  └── mounts React micro-frontend at /jobplatform/
```

**Live today**: scraper pipeline end-to-end (greenhouse / lever / linkedin / remoteok, ~7,600 jobs in D1 as of 2026-08-13, daily scheduled scrape via hadoku_site cron), worker `/ingest` receiving inline webhooks, `/directives` serving the scrape directive, D1 storage, scoring on read, `/jobs` / `/profiles` / `/companies/match` / `/companies/probe` APIs, full V1/V2 UI (profile CRUD sidebar, job list with score/filter/pagination, detail drawer with score breakdown + triage buttons, companies manager), `job_states` triage persistence, per-user scoping (`profiles.user_id`), and V3 tailored resume / cover letter over the `RESUME` service binding.

---

## Scraper Integration (live)

The scraper side is operational. 3,000+ jobs across greenhouse / lever / linkedin in D1, scheduled daily scrape live (GH + LV at 06:01 UTC, LinkedIn on its own cadence — unified cron landing via hadoku_site). Full API reference: `hadoku-scrape/docs/jobboards-api.md`. OpenAPI: `https://scraper.hadoku.me/openapi.json`.

### Ownership split

- **Scraper owns**: resolver, target registry (SQLite), orchestrator, ATS-specific scraping, KV writes, webhook delivery, auto-disable on repeated failures.
- **Jobplatform owns**: per-user company list, scoring profiles, scoring, ranking, dedup, UI.
- **Contract**: jobplatform calls `POST /api/v1/jobboards/targets` when a user adds a company. Scraper does the rest and fires webhooks to `/jobplatform/api/ingest`.

### How each source works

| Source         | Mechanism                                                                | Notes                                                                                                                                |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Greenhouse** | Company enumeration via resolved `(greenhouse, slug)`                    | No salary field. 2,250+ jobs live. Historical empty-description rows pending KV rehydration (see `project_description_backfill.md`). |
| **Lever**      | Company enumeration via resolved `(lever, slug)`                         | No salary field. 250+ jobs live.                                                                                                     |
| **LinkedIn**   | Keyword search; auth via `browser-cookie3` (local Firefox/Chrome cookie) | 240+ jobs live with populated `location` + `workplace_type` after the 2026-04-19 extraction fix.                                     |
| **Ashby**      | Company enumeration via resolved `(ashby, slug)`                         | Live — `ashby` is in `IngestPayloadSchema.source` and Ashby jobs are ingesting.                                                      |

### Scraper API surface (all live)

Base: `https://scraper.hadoku.me/api/v1/jobboards/`
Auth: `Authorization: Bearer $HADOKU_API_KEY`

| Method | Path                              | Purpose                                                                                                                                                                                      |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/resolve`                        | Resolve display names to `(ats, slug)`; handles cache + aliases                                                                                                                              |
| POST   | `/targets`                        | Add targets by `companies: [name]` or `targets: [{ats, slug}]`. Accepts `use_llm`. Returns `AddTargetsData { added: TargetView[], skipped, added_count }` — one call does resolve + register |
| GET    | `/targets`                        | List active + disabled targets with bookkeeping                                                                                                                                              |
| DELETE | `/targets/{target_id}`            | Hard-delete (note: `target_id` is **integer**)                                                                                                                                               |
| POST   | `/targets/{target_id}/reactivate` | Clear auto-disable failure state                                                                                                                                                             |
| POST   | `/search`                         | Trigger scrape across all active targets (202, fire-and-forget)                                                                                                                              |
| POST   | `/preflight`                      | Auth + connectivity check                                                                                                                                                                    |
| POST   | `/prune`                          | Purge stale `jobplatform:raw:*` from KV                                                                                                                                                      |

### TargetView shape (stored on our side as `user_companies.target_id`)

```typescript
interface TargetView {
  id: number // integer — NOT a string UUID
  ats: string // "greenhouse" | "lever" | "linkedin" | "ashby"
  slug: string
  added_at: string
  last_scraped_at: string | null
  last_job_count: number | null
  consecutive_failures: number
  disabled_at: string | null
  disabled_reason: string | null
  is_active: boolean
}
```

### KV write schema (confirmed, archival)

```
key:      jobplatform:raw:{source}_{job_id}       // note: underscore, not colon, between source and id
value:    { ...JobListing fields }
metadata: { scraped_at, source, run_id }
```

KV is written by the scraper for archival and `/prune` support. **The jobplatform worker does not currently read KV** — the ingest handler reads jobs from the webhook body inline. KV reads would only be useful if we later shrink the webhook to ID-only for replay/rescore; not planned for V1.

### Webhook payload per batch (confirmed — matches `IngestPayloadSchema`)

```json
{
  "jobs": [
    {
      "id": "lever_abc123",
      "url": "...",
      "source_site": "lever",
      "title": "...",
      "company": "...",
      "location": "...",
      "description": "...",
      "...": "..."
    }
  ],
  "source": "lever",
  "batch_number": 1,
  "is_final": false,
  "search_term": "optional"
}
```

Headers: `X-User-Key: {admin_or_friend_key}` (standard hadoku auth via `requireMinTier('friend')`).

Jobs are sent **inline**, not as `{job_ids[]}`. One webhook carries up to 25 full job records.

### Scheduling

Scheduling lives in hadoku_site. The `mgmt-api` cron-jobs dispatcher fires `POST /api/v1/jobboards/search` with explicit body `{"sources": ["greenhouse", "lever", "linkedin"]}` on the existing 2am UTC daily cadence driven by `monitoring-api` CF cron. jobplatform-worker's `createScheduledHandler` stays a stub; owning the cadence upstream is cleaner than duplicating it here.

---

## Data Model

Current D1 schema (migrations 0001–0010): `profiles`, `jobs`, `profile_companies`, `job_states`. There is no standalone `users` table — identity is carried inline on each row's `user_id`. `job_profile_matches` was dropped in 0008 (scoring moved on-read) and `user_companies` was superseded by `profile_companies` in 0007, surviving only as harmless legacy.

### Users & Company Subscriptions (V1, shipped)

```typescript
interface User {
  id: string // derived from hadoku auth X-User-Key identity
  created_at: string
}

interface UserCompany {
  id: string // our own id
  user_id: string
  target_id: number // integer — from scraper's TargetView.id
  ats: string // denormalized for quick filtering
  slug: string
  display_name: string // what the user typed
  added_at: string
}
```

On `POST /companies`, jobplatform calls scraper `/targets` with `{companies: [display_name], use_llm: true}`, reads `AddTargetsData.added[]`, and writes one `user_companies` row per returned `TargetView`. On `DELETE /companies/:id` we call scraper `DELETE /targets/{target_id}` and remove our row.

Jobs are joined to users at query time via `jobs.company` (or, preferably, via a stable `(ats, slug)` stored on each job — see Open Questions).

### Profiles

A **profile** defines a class of role you're looking for. Maintain 5–10 simultaneously (e.g., "Senior SWE — AI/ML", "Staff Engineer — Platform", "Principal — Startups"). **Currently global**: profiles have no `user_id` column. V1 stays global; V2 readiness adds `profiles.user_id` before any real profile data lands in prod (see Open Questions — "V2 readiness").

```typescript
interface JobProfile {
  id: string
  name: string // e.g. "Senior SWE — AI/ML"
  keywords: string[] // Match against title + description
  target_companies: string[] // Boosted score if matched
  track: 'ic' | 'manager' | 'either' // Direct reports or not — a HARD filter
  levels: RoleLevel[] // Rungs on that track's ladder — scored by distance
  remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any'
  created_at: string
}
```

**`track` / `levels` replaced `role_types` (migration 0009).** The old field was a
flat OR-list mixing two orthogonal axes — `senior`, `staff`, `principal`, `lead`,
`manager`, `director` — matched as substrings against the raw title. Because
`senior` and `manager` were alternatives to each other, the only expressible
query was "one of these words appears somewhere in the title", and a Senior
Engineering Manager scored identically to a Senior Engineer.

- `track` answers "does this role have direct reports?" and is applied as a hard
  SQL filter on `jobs.role_track`, the same way the profile's companies are.
  Ranking a management role slightly lower is not what "I want IC roles" means.
- `levels` are rungs — IC: `junior | mid | senior | staff | principal | fellow`;
  manager: `manager | senior_manager | director | vp | cxo` — and score by
  distance (exact 1.0, one rung off 0.7, otherwise 0.2, unclassified 0.5).

`min_salary` and `experience_levels` were dropped in the same migration.
Salary is a **view filter and sort** on the feed, never a profile criterion; the
old 0.05 weight was noise because `salary_min` is NULL on most postings and the
factor returned a neutral 0.5 for all of them. `experience_levels` was
round-tripped through every read and write since 0001 and never read by the
scorer — its seed value was a verbatim copy of `role_types`.

### Role classification

No ATS publishes a track or a level. Greenhouse exposes departments/offices/
metadata, Ashby `department`/`team`/`employmentType`, Lever `categories.team` +
`commitment` — none carry a level field or a management flag. Both axes are
therefore **inferred at ingest** by `worker/src/roleClassify.ts` and stored on
the `jobs` row, so the feed can filter and sort on them in SQL rather than
re-deriving them from the title on every read.

The classifier reads the _head_ of the title (before the first comma or dash),
since titles are overwhelmingly `«role», «team/region»` and the tail routinely
carries words that mean something else there — "Software Engineer, Ads Manager"
is an IC. Titles that name a management word but describe an IC (Technical
Program Manager, Account Director) are excluded explicitly. Only the genuinely
ambiguous `lead` family falls through to a description probe for phrases like
"direct reports" or "manage a team of"; "Tech Lead" is IC by convention and
skips it, because a wrong track makes a job invisible.

`POST /ingest/backfill-roles` classifies rows ingested before 0009, and
`?reclassify=true` re-runs the whole table after a classifier change.
Regression cases live in `worker/tests/roleClassify.test.ts` (`pnpm test`) and
were derived from running the classifier over 800 live corpus titles.

### Jobs

Raw job postings as ingested from KV. Mirrors hadoku-scrape's `JobListing` model.

```typescript
interface JobPosting {
  id: string // {source}_{original_id}
  title: string
  company: string
  url: string
  location: string
  remote_type: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  job_type: 'full_time' | 'part_time' | 'contract' | 'unknown'
  experience_level: string
  salary_min: number | null // Unreliable — ~5% fill rate on LinkedIn, absent on GH/Lever
  salary_max: number | null // Same caveat
  description: string // Full text — reliable across all sources
  source: 'linkedin' | 'greenhouse' | 'lever'
  scraped_at: string
  run_id: string
  raw_data: Record<string, unknown>
}
```

### Profile Matches

The join between jobs and profiles. One job can score against multiple profiles independently. Rerunnable when profiles change.

```typescript
interface ProfileMatch {
  job_id: string
  profile_id: string
  score: number // 0.0 – 1.0
  score_breakdown: {
    title_match: number // weight 0.30
    keyword_match: number // weight 0.40
    level_match: number // weight 0.15
    remote_match: number // weight 0.15
  }
  matched_at: string
}
```

### Job States (V2, shipped)

```typescript
interface JobState {
  job_id: string
  user_id: string // same opaque id as user_companies
  state:
    | 'new' // default on first ingest; not written until user transitions
    | 'interested'
    | 'dismissed'
    | 'saved' // shortlist for later
    | 'applied' // set by V4 auto-apply or manual UI
    | 'offered'
    | 'rejected'
  notes: string | null // free-text, replaced on each PUT
  updated_at: string
}
```

Migration: `job_states` with `PRIMARY KEY (job_id, user_id)`. No state row = `new` (implicit). Transitions are unconstrained in V2 — the UI enforces the flow, the backend accepts any valid state. V5 will layer a `job_events` append-only log on top for full history.

### Deduplication

Scraper does not deduplicate across sources. Our ingest logic:

- **Same-source dedup**: `url` as unique key — if already seen, skip
- **Cross-source dedup**: match on `(company, title, location)` — merge into canonical record, keep all source URLs

---

## Worker API

Base path: `/jobplatform/api`

### Implemented

The authoritative route table (method, path, tier, purpose) lives in
[`CLAUDE.md`](./CLAUDE.md#worker-api) — it is kept in sync with the code rather
than duplicated here. In outline:

```
GET   /health                    ← open
GET   /jobs?profile_id=&...      ← open; profile_id optional, sort=score|date|salary,
                                   min_score, min_salary, state (friend), hide_dismissed
GET   /jobs/:id                  ← open; full job detail + score breakdown
GET   /jobs/preflight            ← open; "does this connect to something real?"
PUT   /jobs/:id/state            ← friend; triage state
POST  /jobs/:id/{resume,cover-letter,application-extras,packet-link}
                                 ← friend; via the RESUME service binding
GET   /profiles, POST /profiles, PUT|DELETE /profiles/:id
                                 ← friend
GET|POST /profiles/:id/companies, DELETE /profiles/:id/companies/:companyId
                                 ← friend; the profile's company slice
POST  /companies/match           ← friend; read-only proxy to scraper /match
POST  /companies/probe           ← friend; read-only proxy to scraper /probe
POST  /ingest                    ← friend; scraper webhook, inline jobs
POST  /ingest/backfill-{slugs,roles}
                                 ← friend; one-off reparse/reclassify
GET   /directives                ← friend; the scrape directive the scraper PULLS
GET   /openapi.json
```

**Retired.** `GET|POST|DELETE /companies` (the user-global subscribe/unsubscribe
endpoints) and `POST /ingest/rescore` no longer exist. Companies moved under
profiles in migration 0007, and rescore died with `job_profile_matches` in 0008.
The scraper-push client helpers (`addTargetsByName`, `addTargetBySlug`,
`deleteTarget`) were deleted 2026-08-13. `GET /jobs?mine=true` is likewise gone —
per-profile company scoping replaced it.

User identity is the stable per-user id that edge-router injects as `X-User-Id`,
falling back to the legacy opaque `sha256(credential).slice(0, 16)` only for
callers that bypass the edge. Raw credentials never enter D1.

Outbound calls go through `worker/src/clients/scraper.ts`, which requires the
`SCRAPER_USER_KEY` binding and sends it as `X-User-Key` (a service-tier key from
vault `JOBPLATFORM_SCRAPER_KEY`). Bearer was deprecated 2026-05-05.

### Job → company join

`(ats, slug)` is derived at ingest time from `job.url` by `worker/src/slugParse.ts`
— four patterns today (lever, greenhouse boards, ashby, linkedin + the
stripe.com/gh_jid shortlink) — and stored on the `jobs` table via migration 0003.
It scopes a profile's feed to its companies' jobs. Unmatched URLs get NULL.
`POST /ingest/backfill-slugs` re-parses historical rows (idempotent).

### V1 — implemented (UI)

`src/components/CompaniesManager.tsx` — list / add / remove view mounted in the main app content area. Accepts an optional `apiKey` prop via `JobPlatformProps`; when omitted, uses `credentials: 'include'` and relies on hadoku_site's edge-router to inject auth from the session cookie.

### V1 — to build (UI-only)

Profile CRUD UI, job list view, job detail drawer, and wiring against existing `/jobs`, `/profiles`, `/jobs/:id`, `/companies` routes. No new backend endpoints.

Scheduling is not a V1 task for this repo — hadoku_site's `mgmt-api` cron dispatches `/api/v1/jobboards/search` on the existing 2am UTC daily cadence. `createScheduledHandler` in this worker remains a stub and is not expected to be used.

### V2 — shipped (triage state)

Per-user, per-job lifecycle. Without this every dashboard visit re-triages the same jobs you already looked at yesterday.

```
PUT   /jobs/:id/state            ← set state + optional notes; upserts on (job_id, user_id)
GET   /jobs/:id/state            ← read current state for the authed user
GET   /jobs?state=X              ← filter list by state (combinable with profile_id, mine, min_score)
```

All gated by `requireMinTier('friend')`. Per-user via the same `userIdFromCredential()` helper as `user_companies`. Default state on first ingest is `new`; user transitions to `interested / dismissed` from the card. From `interested`: `→ saved → applied → { offered | rejected }`.

Schema: new `job_states (job_id, user_id, state, notes, updated_at)` table with `UNIQUE(job_id, user_id)`. See Data Model below.

### V3 — shipped 2026-07-14 (tailored applications)

```
POST  /jobs/:id/resume           ← tailored resume via Cloudflare service binding to resume-api
POST  /jobs/:id/cover-letter     ← cover letter via same service binding
```

Both gated by `gateAuthed` (admin/friend) inbound; the handler pulls the job's
title/company/description from D1 and proxies to resume-api over the `RESUME`
service binding, stamping `X-Edge-Auth` + `X-Hadoku-Tier: service` (see the
corrected Auth model section — a raw binding call would 403 without the stamp).
The JobDrawer "Generate packet" button calls both and shows the resume +
cover-letter markdown copy-paste-ready.

### V4 — deferred (tiered apply)

Every job gets an **apply tier** describing how automatable its application is.
The tier drives the primary action shown in the JobDrawer and what the daily
cron is allowed to do unattended.

| Tier      | Meaning                                                                                                                                   | Primary UI action                                                                   | Cron behavior                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| `auto`    | Standard form on a known ATS, no custom essay questions — system can submit end-to-end                                                    | "Auto-apply"                                                                        | may submit unattended (per-user opt-in + daily cap) |
| `approve` | System can fill everything but the submission needs human review (custom questions answered by LLM, salary fields, demographic questions) | "Prepare application" → review screen → one-click submit                            | prepares and queues, never submits                  |
| `assist`  | Can't drive the form (login wall, captcha, Workday/in-house ATS, LinkedIn) — but we still scrape the posting and generate materials       | "Generate packet" (tailored resume + cover letter + variant link, copy-paste ready) | generates packet for high scorers                   |

Classification is two-stage:

1. **Static default at ingest** from `(ats, source_site)`: greenhouse/lever/ashby
   start at `approve`, everything else at `assist`. Nothing defaults to `auto`.
2. **Form introspection (scraper) upgrades/downgrades**: before an
   `approve`-tier apply, the scraper fetches the application form; if every
   field maps to a known schema (name/email/resume/linkedin/standard selects)
   the job is eligible for `auto` (still requires per-user opt-in); any unknown
   or free-text question pins it at `approve`; fetch failure/captcha demotes to
   `assist`.

Per-user override wins over both (e.g. pin a specific company to `assist`).
LinkedIn is permanently `assist` — browser automation there is an account-ban
risk (locked decision, see hadoku_site job-search-orchestration.md).

```
POST  /jobs/:id/apply            ← tier auto/approve: trigger prepare (and submit when allowed)
GET   /jobs/:id/application      ← prepared packet: filled fields, generated answers, artifacts
POST  /jobs/:id/application/approve  ← human sign-off on an approve-tier prepared submission
```

Schema: `jobs.apply_tier` (text, set at ingest), `application_packets
(job_id, user_id, resume_markdown, cover_letter, answers_json, variant_slug,
status: draft|ready|approved|submitted|failed, created_at, submitted_at)`.
Browser execution happens in hadoku-scrape; result webhooks back and writes
state=`applied` in the V2 table. A submitted packet also archives the exact
materials sent — provenance for V5 follow-ups.

### V5 — deferred (tracking & follow-ups)

```
GET   /applications              ← list tracked applications with timeline
GET   /jobs/:id/timeline         ← state transition history for one job
PUT   /jobs/:id/follow-up        ← set next_follow_up_date, contact_name, notes
```

New `job_events (id, job_id, user_id, event_type, notes, occurred_at)` append-only log. UI: vertical timeline in the job detail drawer + Kanban across all in-flight applications.

### V6 — deferred (alerts & digest)

```
GET   /alerts/config             ← per-profile alert preferences
PUT   /alerts/config             ← update per-profile threshold, channel, frequency
```

Config per-profile: `alert_min_score`, `alert_channel` (`email` | `push` | `none`), `alert_frequency` (`daily` | `realtime`). Triggered from the existing daily `/search` cron completion hook. Delivery via hadoku_site's existing Resend integration and/or web-push. V2 triage state suppresses already-triaged jobs from the digest.

---

## Scoring Algorithm

Runs on read, per request (see `worker/src/routes/jobs/feed.ts`) — the precomputed
`job_profile_matches` table was dropped in migration 0008, so scores always
reflect the profile as it is right now.

Three criteria are **hard filters in SQL**, not score factors, because "only
show me X" is a different request from "rank X higher": the profile's companies,
its `track`, and (as a view control) the feed's `min_salary`.

```typescript
function scoreJobAgainstProfile(job: JobPosting, profile: JobProfile): number {
  const signals = {
    title_match: matchTitleKeywords(job.title, profile.keywords), // 0.30
    keyword_match: matchDescriptionKeywords(job.description, profile.keywords), // 0.40
    level_match: matchLevel(job.role_level, profile.levels), // 0.15
    remote_match: matchRemote(job.remote_type, profile.remote_pref) // 0.15
  }
  return weightedSum(signals) // 0.0 – 1.0
}
```

---

## Resume-Bot Integration (V3)

Both endpoints already exist in `@wolffm/resume-bot/api` (`hadoku-resume-bot/worker/src/{tailored-resume.ts,cover-letter.ts}`) and are mounted live at `https://hadoku.me/resume/api/`. They were added in resume-bot commit `8fcc209`.

### Verified state (2026-04-19)

Live probed with a real job posting + admin key:

- `POST /resume/api/cover-letter` — **HTTP 200**, coherent letter (Groq). Reads the plaintext `resume` key from `CONTENT_KV`. **Production-ready.**
- `POST /resume/api/tailored-resume` — **HTTP 200 as of 2026-07 (blocks now seeded)**. Was 500 `"No resume blocks found"` at the 2026-04-19 audit; the block library (`resume:blocks:index` + `resume:blocks:*`) has since been seeded to prod `CONTENT_KV`, verified returning a real assembled resume. Both endpoints are live for V3.

Both endpoints shipped in V3 (2026-07-14). The block library is seeded in prod and `/tailored-resume` returns 200 — the "blocked on block seeding" caveat that lived here is resolved.

### Endpoint contracts (implemented)

```
POST /resume/api/tailored-resume
  body:    { job_title, company, description, profile_type?, tailor?: boolean }
  returns: { resume_markdown: string, blocks_used: string[], cached: boolean }
  caching: 24h KV, keyed on (job_title, company, description)

POST /resume/api/cover-letter
  body:    { job_title, company, description, tone?: 'formal' | 'conversational' }
  returns: { cover_letter_markdown: string, cached: boolean }
  caching: 24h KV, same key shape
```

Input shape matches jobplatform's `jobs` table exactly — no translation layer needed. Tailored-resume does a 2-pass LLM flow (block selection → optional rewrite). Cover-letter does a single pass against the plaintext resume.

### Auth model (important — differs from jobplatform)

> **Corrected 2026-07-14 (V3 implementation).** The claims below were true when
> written, but resume-bot added in-worker auth on 2026-07-13
> (`@wolffm/resume-bot@1.2.3`+): `createEdgeAuth()` + `requireMinTier(...)`. So a
> service binding call is **not** trusted just because it's a binding — it hits
> the same gate any request does and must present provenance. See the corrected
> flow below.

- Resume-bot worker code **now has in-worker auth**: `createEdgeAuth()` verifies
  `X-Edge-Auth` against `EDGE_AUTH_SECRET`; a request with no valid stamp degrades
  to `public`. `requireMinTier(...)` then gates the protected routes. As of
  `@wolffm/resume-bot@1.2.4`, `/tailored-resume` and `/cover-letter` accept
  `['admin','friend','service']`; `/system-prompt` and `/variants` stay
  `['admin','friend']`.
- A **Cloudflare service binding bypasses the edge**, so the binding call carries
  no edge stamp by default → it would land as `public` → **403**. jobplatform-api
  must stamp the provenance itself. It already holds `EDGE_AUTH_SECRET` (same
  shared value resume-api verifies), so:

  ```toml
  # hadoku_site/workers/jobplatform-api/wrangler.toml
  [[services]]
  binding = "RESUME"
  service = "resume-api"
  ```

  ```ts
  // jobplatform worker (@wolffm/jobplatform-worker)
  env.RESUME.fetch('https://resume-api/resume/api/tailored-resume', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Edge-Auth': env.EDGE_AUTH_SECRET, // provenance
      'X-Hadoku-Tier': 'service' // its actual tier
    },
    body: JSON.stringify({ job_title, company, description })
  })
  ```

  Note the **full path** (`/resume/api/...`) — resume-api's Hono router does no
  prefix stripping, so a bare `/tailored-resume` 404s.

### Resume blocks shape

The real block type (`hadoku-resume-bot/worker/src/blocks.ts`):

```typescript
interface ResumeBlock {
  id: string
  type: 'experience' | 'project' | 'skills' | 'education' | 'summary' | 'header'
  tags: string[] // freeform; used for profile_type filtering
  title: string
  content: string // markdown
  priority: number
}
```

Blocks live in `CONTENT_KV` under `resume:blocks:index` (array of IDs) + `resume:blocks:{id}`. `profile_type` is a freeform hint — the LLM prefers blocks whose `tags` match but isn't restricted to them. **There is no `swe` / `ml_ai` / `leadership` / `creative` taxonomy** — that was aspirational.

### Block seeding — done

Blocks are seeded in prod `CONTENT_KV` (`resume:blocks:index` + `resume:blocks:*`,
51 blocks / 81 tags), and `POST /resume/api/tailored-resume` returns 200 with a
real assembled resume. Seeding is a resume-bot-side task (`hadoku_site/scripts/
admin/resume_ingest.py --blocks`). The 2026-04-19 "verified unseeded / 500"
finding is history — both V3 endpoints are live.

---

## UI Design (V1)

```
┌─ Sidebar ──────────┐ ┌─ Job List ─────────────────────────────────┐
│                    │ │                                              │
│  ● Senior SWE/ML   │ │  [Search]  [Sort: Score ▾]  [Min: 0.7]     │
│  ○ Staff Platform  │ │                                              │
│  ○ Principal/Arch  │ │  ┌─ Job Card ──────────────────────────┐    │
│  ○ Startup Eng     │ │  │ Senior ML Eng · Anthropic · Remote  │    │
│  ○ Creative        │ │  │ $200k–$300k · LinkedIn · Score 0.97 │    │
│                    │ │  └─────────────────────────────────────┘    │
│  + New Profile     │ │                                              │
│                    │ │  ┌─ Job Card ──────────────────────────┐    │
└────────────────────┘ │  │ Staff Eng · Google DeepMind · Hybrid │   │
                        │  │ Salary unknown · Greenhouse · 0.94  │   │
                        │  └──────────────────────────────────────┘   │
                        └──────────────────────────────────────────────┘
```

Job detail opens in a right-side drawer: full description, score breakdown by signal, source URL, and action buttons — disabled in V1, activated in V2 (triage: interested/dismissed/saved/applied) and extended in V3 with the "Generate packet" button (tailored resume + cover letter).

---

## Auth

| Endpoint                                                             | Auth                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /ingest`                                                       | `requireMinTier('friend')` (the scraper posts as service, which outranks friend) |
| all `/profiles`, `/companies/*`, `GET /directives`                   | `requireMinTier('friend')` in-worker                                             |
| `PUT/DELETE /jobs/:id/state`, `POST /jobs/:id/{resume,cover-letter}` | `gateAuthed` (admin/friend) in-worker                                            |
| Read-only `GET /jobs`, `/jobs/:id` (unscoped)                        | Public                                                                           |

All gating is **in-worker** via `@wolffm/worker-utils` `createEdgeAuth()` + `requireMinTier()` (tiers rank `public < friend < service < admin`; a gate names the lowest tier and admits everything above it) — the worker trusts the edge-stamped `X-Hadoku-Tier` only when `X-Edge-Auth` verifies. (It is no longer true that "all other endpoints are open, gated only upstream".)

---

## Open Questions

### V1/V2 remaining

- [ ] **`IngestPayloadSchema.source` enum** — still locked to `greenhouse | lever | linkedin` (`worker/src/schemas.ts:186`). Scraper's resolver supports Ashby. Loosen to `z.string()` or extend before first Ashby target is added.
- [ ] **Verify a real profile exists in prod** — profile CRUD UI shipped (`ProfileSidebar`), but confirm the production `profiles` table actually has a row so scoring runs against ingested jobs.

### V3 — shipped 2026-07-14, with follow-ups

- [x] **Block seeding** — blocks seeded in prod (`resume:blocks:*`); `/tailored-resume` returns 200.
- [x] **Service binding wiring** — `RESUME` binding declared (hadoku_site#193) and used (`worker/src/routes/jobs/tailoring.ts`), stamping `X-Edge-Auth` + `X-Hadoku-Tier: service`.
- [ ] **`profile_type` vocabulary** — jobplatform scoring profiles and resume-bot block tags are freeform on both sides. The V3 UI does NOT pass `profile_type` yet (the passthrough is wired but unused) pending a shared vocab (e.g. `ml`, `staff`, `leadership`), or they'll drift.
- [x] **Application-packet provenance** — migration 0010 adds `job_states.variant_slug`, stashing the minted packet link on the state row so the record of what was actually sent survives. A "Generate" vs "Regenerate" hint for the resume itself is still not cached; the UI round-trips resume-bot for that.

### V4+ to scope later

- [ ] **Auto-apply retry / captcha / lockout semantics** (V4) — not designed. Blocks include LinkedIn account-safety risk.
- [ ] **Ingest pipeline refactor** — ingest is a synchronous monolith (dedup + insert + score-all-profiles per job per batch). Fine today; when V3 or V4 adds per-job enrichment (LLM call, form introspection) we'll need a queue/cron-driven pipeline with per-job status columns. Defer until we hit the 30s edge budget.

### Resolved

- [x] **V1 shipped** — scrape → ingest → score → browsable UI live at `/jobplatform` (whitelisted + friend-gated in hadoku_site `src/pages/[app].astro`).
- [x] **V2 shipped** — `job_states` table (migration 0005), triage endpoints + JobDrawer buttons, `profiles.user_id` (migration 0004), react-router UI scaffolding (HashRouter, list ↔ drawer ↔ companies).
- [x] **V3 shipped (2026-07-14)** — `POST /jobs/:id/{resume,cover-letter}` proxy to resume-api over the `RESUME` service binding; JobDrawer "Generate packet" button renders both artifacts.
- [x] **`/jobs` requires `profile_id`** — now `.optional()` (`worker/src/routes/jobs/feed.ts`).
- [x] **User scoping** — `user_companies` table + `userIdFromCredential()` helper shipped. Profiles staying global for V1; per-user scoping moved to V2 readiness.
- [x] **Stable job → company join** — `worker/src/slugParse.ts` derives `(ats, slug)` from `job.url` at ingest time; stored on the `jobs` table (migration 0003) and used to scope a profile's feed to its companies.
- [x] **Scheduler** — `createScheduledHandler` stays a stub. hadoku_site's `mgmt-api` cron owns the daily `/api/v1/jobboards/search` dispatch.
- [x] **LinkedIn `li_at` cookie** — no blocker. Scraper uses `browser-cookie3` to extract from Firefox/Chrome.
- [x] **Auth on ingest** — `requireUserType(['admin','friend'])` via `X-User-Key`, confirmed live.
- [x] **Scraper company-list ownership** — scraper owns the target registry; jobplatform owns only per-user subscriptions.
- [x] **Webhook shape** — inline jobs `{jobs, source, batch_number, is_final, search_term?}`, not ID-only.
- [x] **LinkedIn `location` / `workplace_type` extraction** — 2026-04-19 fix populated both fields across all 240 current LinkedIn rows (after wipe + re-scrape).
