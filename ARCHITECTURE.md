# Job Platform — Architecture & Vision

## Vision

A job hunting pipeline that automatically aggregates postings from multiple sources, scores them against configurable role profiles, and gives a clean front-end to review, apply, and track applications.

### Roadmap

| Phase | Scope |
|-------|-------|
| **V1 — Scrape & Display** | Ingest jobs from hadoku-scrape → score against profiles → browsable UI per profile |
| **V2 — Tailored Applications** | Request customized resumes and cover letters from resume-bot per job posting |
| **V3 — Auto Apply** | Automated apply flow for LinkedIn Easy Apply (and later Greenhouse/Lever) |
| **V4 — Full Tracking** | End-to-end pipeline: applied → interviewing → offer → rejected, with notes and follow-up dates |

---

## System Architecture

This package follows the same pipeline pattern as `hadoku-aggregator`:

```
hadoku-scrape (Python FastAPI)
  │  LinkedIn: keyword search via URL params
  │  Greenhouse/Lever: company enumeration (get_all_jobs per company)
  │  writes raw job data to shared Cloudflare KV (jobplatform:raw: prefix)
  │  sends lightweight webhook to our worker after each batch
  ↓
POST /jobplatform/api/ingest  (our worker — receives batch notification)
  │  fetches full job records from KV by job_id
  │  scores each job against all profiles
  │  stores matches in D1
  ↓
@wolffm/jobplatform-worker (Hono, this repo)
  │  reads D1 for scored/filtered job lists
  │  exposes REST API
  ↓
@wolffm/jobplatform (React, this repo)
  │  per-profile job browser
  │  job detail drawer + action panel
  │  mounts in hadoku_site
  ↓
hadoku_site
  └── routes /jobplatform/api/* → Cloudflare Worker
  └── mounts React micro-frontend at /jobs/
```

---

## Scraper Integration (confirmed)

### How each source works

| Source | Mechanism | Notes |
|--------|-----------|-------|
| **LinkedIn** | Keyword search via URL params (`f_E`, `f_JT` filters) | Requires `li_at` cookie auth — **pending confirmation** |
| **Greenhouse** | `get_all_jobs(company)` — enumerates all listings for a company | Config-driven company list; no salary field |
| **Lever** | `get_all_jobs(company)` — enumerates all listings for a company | Config-driven company list; no salary field |

### Scraper config shape (`config/jobplatform.json` in hadoku-scrape)

```json
{
  "sources": {
    "linkedin": {
      "enabled": true,
      "search_terms": [
        "Senior Software Engineer",
        "Staff Engineer",
        "Principal Engineer",
        "Senior ML Engineer"
      ],
      "locations": ["Remote", "Seattle, WA", "San Francisco, CA"],
      "filters": {
        "experience_levels": ["MID_SENIOR", "DIRECTOR"],
        "job_types": ["FULL_TIME"]
      },
      "max_results_per_term": 100,
      "rate_limit": { "min_delay_s": 10, "max_delay_s": 30 }
    },
    "greenhouse": {
      "enabled": true,
      "companies": ["stripe", "openai", "anthropic"]
    },
    "lever": {
      "enabled": true,
      "companies": ["vercel", "linear", "notion"]
    }
  },
  "schedule": "0 8 * * *",
  "delivery": {
    "kv_prefix": "jobplatform:raw",
    "callback_url": "https://hadoku.me/jobplatform/api/ingest"
  }
}
```

### KV write schema (confirmed)

```
key:      jobplatform:raw:{source}:{job_id}
value:    { ...JobListing fields }
metadata: { scraped_at, source, run_id }
```

Shared namespace (`SCRAPER_KV_NAMESPACE_ID`) with `jobplatform:raw:` prefix — same namespace as OSS data (`recon:` prefix), no collision.

### Webhook payload per batch (confirmed)

```json
{
  "event": "jobplatform.batch",
  "run_id": "jobscrape_20260324_080000",
  "batch_number": 1,
  "is_final": false,
  "data": {
    "job_ids": ["linkedin_123", "linkedin_124"],
    "count": 25,
    "source": "linkedin",
    "search_term": "Senior Software Engineer"
  }
}
```

Headers: `X-User-Key: {admin_or_friend_key}` (standard hadoku auth via `requireUserType`)

### Scheduling

**Not** a GitHub Actions cron. Scraper team will add to hadoku-site's scheduler config (internal PM2 scheduler or hadoku-site management API trigger) to fire `POST /api/v1/jobboards/search` daily at `0 8 * * *`.

### Scraper implementation order (from scraper team)

1. Greenhouse + Lever company enumeration → KV + webhook (immediate)
2. `jobplatform.json` config + `POST /api/v1/jobboards/search` route
3. LinkedIn search URL builder (unblocked — see auth note below)
4. hadoku-site scheduler hookup

### LinkedIn auth

No blocker. Scraper uses `browser-cookie3` to extract `li_at` directly from Firefox/Chrome on the local machine. Only requirement: be logged into LinkedIn in the browser. All three sources can proceed in parallel.

---

## Data Model

### Profiles

A **profile** defines a class of role you're looking for. Maintain 5–10 simultaneously (e.g., "Senior SWE — AI/ML", "Staff Engineer — Platform", "Principal — Startups").

```typescript
interface JobProfile {
  id: string
  name: string                        // e.g. "Senior SWE — AI/ML"
  keywords: string[]                  // Match against title + description
  target_companies: string[]          // Boosted score if matched
  role_types: string[]                // SENIOR | STAFF | PRINCIPAL | LEAD | etc.
  min_salary: number | null           // Informational only — salary data is sparse
  remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any'
  experience_level: string[]          // MID_SENIOR | DIRECTOR | etc.
  created_at: string
}
```

### Jobs

Raw job postings as ingested from KV. Mirrors hadoku-scrape's `JobListing` model.

```typescript
interface JobPosting {
  id: string                          // {source}_{original_id}
  title: string
  company: string
  url: string
  location: string
  remote_type: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  job_type: 'full_time' | 'part_time' | 'contract' | 'unknown'
  experience_level: string
  salary_min: number | null           // Unreliable — ~5% fill rate on LinkedIn, absent on GH/Lever
  salary_max: number | null           // Same caveat
  description: string                 // Full text — reliable across all sources
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
  score: number                       // 0.0 – 1.0
  score_breakdown: {
    title_match: number               // weight 0.25
    keyword_match: number             // weight 0.35 (salary absent → redistribute here)
    company_boost: number             // weight 0.15
    salary_match: number              // weight 0.05 (low weight — data too sparse)
    remote_match: number              // weight 0.10
    seniority_match: number           // weight 0.10
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

### V1

```
POST  /ingest                    ← scraper webhook (Bearer + HMAC auth)
GET   /profiles                  ← list profiles
POST  /profiles                  ← create profile
PUT   /profiles/:id              ← update profile
GET   /jobs?profile_id=&page=&sort=score|date&min_score=
GET   /jobs/:id                  ← full job detail + score breakdown
POST  /jobs/rescore              ← rescore all jobs against updated profiles
GET   /health
```

### V2

```
POST  /jobs/:id/resume           ← proxy to resume-bot tailored-resume endpoint
POST  /jobs/:id/cover-letter     ← proxy to resume-bot cover-letter endpoint
```

### V3

```
POST  /jobs/:id/apply            ← trigger automated apply flow
```

### V4

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
    title_match:     matchTitleKeywords(job.title, profile.keywords),            // 0.25
    keyword_match:   matchDescriptionKeywords(job.description, profile.keywords),// 0.35
    company_boost:   matchTargetCompanies(job.company, profile.target_companies),// 0.15
    seniority_match: matchSeniority(job.experience_level, profile.role_types),   // 0.10
    remote_match:    matchRemote(job.remote_type, profile.remote_pref),          // 0.10
    salary_match:    matchSalary(job.salary_min, profile.min_salary),            // 0.05
  }
  return weightedSum(signals)  // 0.0 – 1.0
}
```

---

## Resume-Bot Integration (V2)

resume-bot currently returns a static markdown resume. V2 requires two new endpoints.

### Required resume-bot endpoints (to be specced with resume-bot team)

```
POST /api/tailored-resume
  body: { job_title, company, description, profile_type }
  returns: { resume_markdown, blocks_used: string[] }

POST /api/cover-letter
  body: { job_title, company, description, tone?: 'formal'|'conversational' }
  returns: { cover_letter_markdown }
```

### Resume blocks concept

resume-bot assembles resumes from typed blocks. Different role types use different block sets:

| Block | Used for |
|-------|----------|
| **swe** | Technical projects, system design, languages/tools |
| **ml_ai** | Models, datasets, research, publications |
| **leadership** | Team size, org design, hiring, roadmap ownership |
| **creative** | Portfolio, shipped products, user impact stories |

`/api/tailored-resume` selects + assembles blocks appropriate for the role, then tailors copy to the job description.

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

| Endpoint | Auth |
|----------|------|
| `POST /ingest` | `requireUserType(['admin', 'friend'])` via `X-User-Key` header (standard hadoku auth) |
| All other worker endpoints | Open — gated by hadoku_site's auth layer upstream |

---

## Open Questions

- [x] **LinkedIn `li_at` cookie** — no blocker. Scraper uses browser-cookie3 to extract the cookie automatically from Firefox/Chrome. Only requirement: be logged into LinkedIn in the local browser.
- [ ] **Auth on read endpoints** — confirm whether hadoku_site passes an auth header downstream to the worker
- [ ] **resume-bot blocks design** — needs a separate design session before V2 starts
- [ ] **Greenhouse/Lever company lists** — finalize the lists of companies to enumerate for each source
