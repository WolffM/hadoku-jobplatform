# Job Platform — Architecture & Vision

## Vision

A job hunting pipeline that automatically aggregates postings from multiple sources, scores them against configurable role profiles, and gives a clean front-end to review, apply, and track applications.

### Roadmap

| Phase                          | Status      | Scope                                                                                        |
| ------------------------------ | ----------- | -------------------------------------------------------------------------------------------- |
| **V1 — Scrape & Display**      | In progress | User subscribes to companies → scraper fetches → ingest → score → browsable UI               |
| **V2 — Tailored Applications** | Deferred    | Per-job tailored resume + cover letter via resume-bot (service binding from jobplatform-api) |
| **V3 — Auto Apply**            | Deferred    | Automated apply flow (LinkedIn Easy Apply first, then Greenhouse/Lever)                      |
| **V4 — Full Tracking**         | Deferred    | Applied → interviewing → offer → rejected, with notes and follow-up dates                    |

---

## System Architecture

End-to-end pipeline (V1 target state — company subscription flow):

```
User adds a company in the jobplatform UI
  ↓
POST /jobplatform/api/companies  (this worker)
  │  writes user_companies row
  │  calls scraper POST /api/v1/jobboards/targets {companies: [display_name]}
  │  stores returned {target_id, ats, slug} from scraper's registry
  ↓
hadoku-scrape (Python FastAPI, sibling repo)
  │  resolves company → (ats, slug) via cache / mechanical / alias / optional LLM
  │  scheduled (or on-demand) POST /api/v1/jobboards/search
  │  enumerates active targets: Greenhouse, Lever, LinkedIn (Ashby resolver-only)
  │  writes each listing to Cloudflare KV: jobplatform:raw:{source}_{id}
  │  POSTs batches of 25 to /jobplatform/api/ingest with FULL jobs inline
  ↓
POST /jobplatform/api/ingest  (this worker)
  │  reads jobs from webhook body (NOT from KV — KV is archival only)
  │  dedups by URL, inserts into D1 jobs
  │  scores each job against every profile, writes job_profile_matches
  ↓
@wolffm/jobplatform-worker (Hono, this repo)
  │  reads D1 for scored/filtered job lists
  │  exposes REST API under /jobplatform/api
  ↓
@wolffm/jobplatform (React, this repo)
  │  company manager + per-profile job browser
  │  job detail drawer + action panel
  │  mounts in hadoku_site
  ↓
hadoku_site
  └── routes /jobplatform/api/* → Cloudflare Worker (hadoku_site/workers/jobplatform-api/)
  └── mounts React micro-frontend at /jobs/
```

**Live today**: scraper pipeline end-to-end, worker `/ingest` receiving inline webhooks, D1 storage, scoring, `/jobs` and `/profiles` APIs.
**Not yet built**: `user_companies` table, `POST /companies`, scraper-client module, UI company manager, scheduled `/search` trigger.

---

## Scraper Integration (live)

The scraper side is operational. End-to-end verified this week: 239 Lever jobs landed via 11 webhook POSTs, all 200. Full API reference: `hadoku-scrape/docs/jobboards-api.md`. OpenAPI: `https://scraper.hadoku.me/openapi.json`.

### Ownership split

- **Scraper owns**: resolver, target registry (SQLite), orchestrator, ATS-specific scraping, KV writes, webhook delivery, auto-disable on repeated failures.
- **Jobplatform owns**: per-user company list, scoring profiles, scoring, ranking, dedup, UI.
- **Contract**: jobplatform calls `POST /api/v1/jobboards/targets` when a user adds a company. Scraper does the rest and fires webhooks to `/jobplatform/api/ingest`.

### How each source works

| Source         | Mechanism                                                                | Notes                                                                    |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Greenhouse** | Company enumeration via resolved `(greenhouse, slug)`                    | No salary field                                                          |
| **Lever**      | Company enumeration via resolved `(lever, slug)`                         | No salary field. **Confirmed live — 239 jobs delivered**                 |
| **LinkedIn**   | Keyword search; auth via `browser-cookie3` (local Firefox/Chrome cookie) | Live                                                                     |
| **Ashby**      | Resolver supported, scraper not yet implemented                          | Adding `ashby` to `IngestPayloadSchema.source` enum is a V1 prerequisite |

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

Headers: `X-User-Key: {admin_or_friend_key}` (standard hadoku auth via `requireUserType(['admin', 'friend'])`).

Jobs are sent **inline**, not as `{job_ids[]}`. One webhook carries up to 25 full job records.

### Scheduling

Nothing is currently scheduled. The pipeline only runs when something calls `POST /api/v1/jobboards/search`. V1 will add a scheduled trigger — either via hadoku_site's scheduler, or via jobplatform-worker's `createScheduledHandler` (currently a stub) calling scraper `/search` on a cron.

---

## Data Model

Current D1 schema (`worker/migrations/0001_init.sql`): `profiles`, `jobs`, `job_profile_matches`. **No `users` table, no `user_companies` table yet** — adding them is the first V1 task.

### Users & Company Subscriptions (V1, not yet built)

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

A **profile** defines a class of role you're looking for. Maintain 5–10 simultaneously (e.g., "Senior SWE — AI/ML", "Staff Engineer — Platform", "Principal — Startups"). **Currently global**: profiles have no `user_id` column. Either scope per-user in V1 or keep global and rely on `user_companies` for per-user filtering — see Open Questions.

```typescript
interface JobProfile {
  id: string
  name: string // e.g. "Senior SWE — AI/ML"
  keywords: string[] // Match against title + description
  target_companies: string[] // Boosted score if matched
  role_types: string[] // SENIOR | STAFF | PRINCIPAL | LEAD | etc.
  min_salary: number | null // Informational only — salary data is sparse
  remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any'
  experience_level: string[] // MID_SENIOR | DIRECTOR | etc.
  created_at: string
}
```

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
    title_match: number // weight 0.25
    keyword_match: number // weight 0.35 (salary absent → redistribute here)
    company_boost: number // weight 0.15
    salary_match: number // weight 0.05 (low weight — data too sparse)
    remote_match: number // weight 0.10
    seniority_match: number // weight 0.10
  }
  matched_at: string
}
```

### Deduplication

Scraper does not deduplicate across sources. Our ingest logic:

- **Same-source dedup**: `url` as unique key — if already seen, skip
- **Cross-source dedup**: match on `(company, title, location)` — merge into canonical record, keep all source URLs

---

## Worker API

Base path: `/jobplatform/api`

### V1 — implemented

```
POST  /ingest                    ← scraper webhook, admin/friend via X-User-Key, inline jobs
POST  /ingest/rescore            ← rescore all jobs against one or all profiles
GET   /profiles                  ← list profiles
POST  /profiles                  ← create profile
PUT   /profiles/:id              ← update profile
GET   /jobs?profile_id=&...      ← ⚠️ profile_id is currently REQUIRED (Zod validation). Fix pending.
GET   /jobs/:id                  ← full job detail + score breakdown
POST  /jobs/rescore              ← rescore all jobs against updated profiles
GET   /health
GET   /openapi.json
```

### V1 — to build

```
POST    /companies               ← user adds a company; proxies to scraper /targets
GET     /companies               ← list this user's subscribed companies
DELETE  /companies/:id           ← unsubscribe; proxies to scraper DELETE /targets/{target_id}
```

Plus the fix to make `/jobs` `profile_id` optional (return all jobs visible to the user when omitted), and a scheduler hookup (probably in `createScheduledHandler`) that calls scraper `/search`.

### V2 — deferred

```
POST  /jobs/:id/resume           ← tailored resume via Cloudflare service binding to resume-api (no HTTPS / no key)
POST  /jobs/:id/cover-letter     ← cover letter via same service binding
```

Rationale for service binding: resume-bot's `/tailored-resume` and `/cover-letter` endpoints exist but are gated by hadoku_site's edge-router (`validateFriendOrAdminKey`). A service binding from `hadoku_site/workers/jobplatform-api/` to `hadoku_site/workers/resume-api/` bypasses the edge entirely — zero-trust pre-authenticated — so jobplatform never needs to hold a key for resume-bot. See Open Questions for block-seeding verification status.

### V3 — deferred

```
POST  /jobs/:id/apply            ← trigger automated apply flow
```

### V4 — deferred

```
GET   /applications              ← list tracked applications
PUT   /applications/:id          ← update status, notes, follow-up date
```

---

## Scoring Algorithm

Runs at ingest time (on webhook receipt). Each incoming job is scored against every profile.

Salary weight deliberately low (0.05) because data is sparse — over-penalizing jobs with no salary data would filter out most listings.

```typescript
function scoreJobAgainstProfile(job: JobPosting, profile: JobProfile): number {
  const signals = {
    title_match: matchTitleKeywords(job.title, profile.keywords), // 0.25
    keyword_match: matchDescriptionKeywords(job.description, profile.keywords), // 0.35
    company_boost: matchTargetCompanies(job.company, profile.target_companies), // 0.15
    seniority_match: matchSeniority(job.experience_level, profile.role_types), // 0.10
    remote_match: matchRemote(job.remote_type, profile.remote_pref), // 0.10
    salary_match: matchSalary(job.salary_min, profile.min_salary) // 0.05
  }
  return weightedSum(signals) // 0.0 – 1.0
}
```

---

## Resume-Bot Integration (V2)

Both endpoints already exist in `@wolffm/resume-bot/api` (`hadoku-resume-bot/worker/src/{tailored-resume.ts,cover-letter.ts}`) and are mounted live at `https://hadoku.me/resume/api/`. They were added in resume-bot commit `8fcc209`.

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

- Resume-bot worker code has **no in-worker auth**.
- Gating happens **upstream in hadoku_site's edge-router**, via a function named `validateFriendOrAdminKey` (per the resume-bot commit message). This is a **different gate** from jobplatform's in-worker `requireUserType(['admin','friend'])`. The two key lists may or may not be the same — verified empirically that a known-good jobplatform `svc-…` service key is accepted on `/jobplatform/api/*` but **rejected** on `/resume/api/{tailored-resume,cover-letter,system-prompt}` with 403.
- **For V2 jobplatform→resume-bot calls**: use a **Cloudflare service binding** between the two host workers, not HTTPS. Service bindings are zero-trust pre-authenticated and bypass the edge-router entirely, so jobplatform never needs to hold a resume-bot key. Wire in `hadoku_site/workers/jobplatform-api/wrangler.toml`:

  ```toml
  [[services]]
  binding = "RESUME"
  service = "resume-api"
  ```

  Then call `env.RESUME.fetch(new Request('/resume/api/tailored-resume', {...}))` from the jobplatform worker.

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

### Block seeding — unverified

**Nothing in the resume-bot repo seeds blocks.** No seed script, no committed block files, no init command — `blocks.ts` only reads. The plaintext `/resume` endpoint works (proof that `CONTENT_KV` has `resume:full` or legacy `resume`), but that's a different KV key from `resume:blocks:*`.

If blocks were never seeded, the first call to `/tailored-resume` will throw `"No resume blocks found in KV storage"` (`tailored-resume.ts:39`). **Must verify before V2 starts** by either:

- Running `wrangler kv:key list --namespace-id=<CONTENT_KV>` and looking for `resume:blocks:*` keys
- Or making an authed call to `/tailored-resume` and reading the error

Block seeding is a resume-bot repo task, not a jobplatform task, but it blocks V2.

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

Job detail opens in a right-side drawer: full description, score breakdown by signal, source URL, and action buttons (disabled in V1, active in V2+).

---

## Auth

| Endpoint                   | Auth                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `POST /ingest`             | `requireUserType(['admin', 'friend'])` via `X-User-Key` header (standard hadoku auth) |
| All other worker endpoints | Open — gated by hadoku_site's auth layer upstream                                     |

---

## Open Questions

### V1 blockers

- [ ] **`/jobs` requires `profile_id`** — Zod marks it required, so with zero profiles there's literally no way to list jobs. One-line fix to make it optional. Do before company-subscription work so we can actually see the 239 Lever jobs already in D1.
- [ ] **User scoping** — two choices: (a) add `users` + `user_companies`, scope profiles per-user too; (b) add only `user_companies`, keep profiles global. Recommend (b) for V1 simplicity. Decide before writing the schema migration.
- [ ] **Stable job → company join** — scraper webhook jobs carry `company` (display name) but no `(ats, slug)`. To join `jobs` to `user_companies` cleanly we need the scraper to include `ats`/`slug` on each ingested job, **or** jobplatform must derive slug from `job.url` per-source. (a) is cleaner — request from scraper side.
- [ ] **`IngestPayloadSchema.source` enum** — currently locked to `greenhouse | lever | linkedin`. Scraper's resolver supports Ashby and will eventually scrape it. Loosen to `z.string()` or extend the enum proactively.
- [ ] **Scheduler** — `createScheduledHandler` is a stub. Decide whether to drive `/search` from jobplatform's cron or hadoku_site's scheduler.
- [ ] **`profiles` empty in prod** — no scoring has run against the 239 ingested jobs because there are no profile rows. Decide whether to seed defaults or wait for UI-driven creation.

### V2 blockers

- [ ] **Resume-bot block seeding** — unverified whether `resume:blocks:index` exists in `CONTENT_KV`. Must verify before starting V2; no seed script exists in the resume-bot repo.
- [ ] **Service binding wiring** — `hadoku_site/workers/jobplatform-api/wrangler.toml` needs a `RESUME` service binding. Coordinated change across hadoku_site + this repo.
- [ ] **`profile_type` vocabulary** — jobplatform scoring profiles and resume-bot block tags are freeform on both sides. Agree on a shared vocabulary (e.g. `ml`, `staff`, `leadership`) or they'll drift.
- [ ] **Tailored-resume provenance on jobs** — add `job_profile_matches.tailored_resume_cached_at` or similar so the UI can show a "Generate" vs "Regenerate" state without round-tripping resume-bot.

### Resolved

- [x] **LinkedIn `li_at` cookie** — no blocker. Scraper uses `browser-cookie3` to extract the cookie automatically from Firefox/Chrome.
- [x] **Auth on ingest** — `requireUserType(['admin','friend'])` via `X-User-Key`, confirmed live with 239 Lever jobs landing.
- [x] **Scraper company-list ownership** — moved to scraper's target registry; jobplatform owns only the per-user subscription list.
- [x] **Webhook shape** — inline jobs `{jobs, source, batch_number, is_final, search_term?}`, not ID-only. Stale doc corrected.
