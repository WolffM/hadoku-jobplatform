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
  │  scrapes: LinkedIn, Greenhouse, Lever, RemoteOK, HackerNews
  │  writes raw job data to Cloudflare KV
  ↓
Cloudflare KV
  jobplatform:raw:{job_id}           → Raw job posting from scraper
  jobplatform:profile:{id}           → User-defined role profiles
  jobplatform:match:{profile}:{job}  → Pre-computed match scores
  ↓
@wolffm/jobplatform-worker (Hono, this repo)
  │  reads KV, scores jobs against profiles
  │  exposes REST API
  ↓
@wolffm/jobplatform (React, this repo)
  │  per-profile job browser
  │  job detail + action panel
  │  mounts in hadoku_site
  ↓
hadoku_site
  └── routes /jobplatform/api/* → Cloudflare Worker
  └── mounts React micro-frontend at /jobs/
```

---

## Data Model

### Profiles

A **profile** defines a class of role you're looking for. You maintain 5–10 profiles simultaneously (e.g., "Senior SWE — AI/ML", "Staff Engineer — Platform", "Principal Engineer — Startups").

```typescript
interface JobProfile {
  id: string
  name: string                        // Display name, e.g. "Senior SWE — AI/ML"
  keywords: string[]                  // Terms to match in title/description
  target_companies: string[]          // Optional company list (boosted score)
  role_types: string[]                // SENIOR | STAFF | PRINCIPAL | LEAD | etc.
  min_salary: number | null           // Minimum acceptable compensation
  remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any'
  experience_level: string[]          // MID | SENIOR | STAFF | etc.
  created_at: string
}
```

### Jobs

Raw job postings as ingested from the scraper. Schema mirrors hadoku-scrape's existing `JobListing` model.

```typescript
interface JobPosting {
  id: string
  title: string
  company: string
  url: string
  location: string
  remote_type: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  job_type: 'full_time' | 'part_time' | 'contract' | 'unknown'
  experience_level: string
  salary_min: number | null
  salary_max: number | null
  description: string
  source: 'linkedin' | 'greenhouse' | 'lever' | 'remoteok' | 'hackernews'
  scraped_at: string
  raw_data: Record<string, unknown>   // Original scraper payload preserved
}
```

### Profile Matches

The join between jobs and profiles. One job can appear under multiple profiles at different scores. Scoring can be rerun against updated profiles without touching the jobs table.

```typescript
interface ProfileMatch {
  job_id: string
  profile_id: string
  score: number                       // 0.0 – 1.0
  score_breakdown: {
    title_match: number
    keyword_match: number
    company_boost: number
    salary_match: number
    remote_match: number
    seniority_match: number
  }
  matched_at: string
}
```

---

## Worker API (V1)

Base path: `/jobplatform/api`

```
POST  /ingest                    ← hadoku-scrape pushes job batches (bearer auth)
GET   /profiles                  ← list all profiles
POST  /profiles                  ← create a profile
PUT   /profiles/:id              ← update a profile
GET   /jobs?profile_id=&page=&sort=score|date&min_score=
GET   /jobs/:id                  ← full job detail
POST  /jobs/:id/score            ← force rescore a single job against all profiles
GET   /health
```

**V2 additions:**
```
POST  /jobs/:id/resume           ← request tailored resume from resume-bot
POST  /jobs/:id/cover-letter     ← request tailored cover letter from resume-bot
```

**V3 additions:**
```
POST  /jobs/:id/apply            ← trigger automated apply flow
```

**V4 additions:**
```
GET   /applications              ← list application tracking records
PUT   /applications/:id          ← update status, add notes
```

---

## Scraper Integration

### KV Schema (agreed with hadoku-scrape)

```
jobplatform:raw:{job_id}         → JobPosting JSON (written by scraper)
jobplatform:index                → { job_ids: string[], last_updated: string }
```

### Ingest Flow

Two options under discussion with hadoku-scrape team (see scraper prompt):

**Option A — Push (preferred):** Scraper calls `POST /ingest` on our worker after each scrape run.

**Option B — Pull:** Scraper writes to KV only; our worker reads KV directly on request.

Option A gives us real-time updates and decouples KV schema from our read logic. Option B is simpler but couples us to the KV layout.

### Scraper Config

We provide a `jobplatform.json` config in hadoku-scrape's `config/` directory:

```json
{
  "sources": ["linkedin", "greenhouse", "lever", "remoteok"],
  "search_terms": [
    "Senior Software Engineer",
    "Staff Engineer",
    "Principal Engineer",
    "Senior ML Engineer",
    "Senior AI Engineer"
  ],
  "locations": ["Remote", "Seattle", "San Francisco", "New York"],
  "filters": {
    "experience_levels": ["MID_SENIOR", "DIRECTOR"],
    "job_types": ["FULL_TIME"]
  },
  "schedule": "0 8 * * *",
  "callback_url": "https://hadoku.me/jobplatform/api/ingest"
}
```

---

## Resume-Bot Integration (V2)

resume-bot currently exposes `GET /api/resume` (returns static markdown). V2 requires two new endpoints from resume-bot:

### Required resume-bot endpoints (to be specced separately)

```
POST /api/tailored-resume
  body: { job_title, company, description, profile_type }
  returns: { resume_markdown, file_url?, blocks_used: string[] }

POST /api/cover-letter
  body: { job_title, company, description, tone?: 'formal'|'conversational' }
  returns: { cover_letter_markdown }
```

### Resume blocks concept

resume-bot will need a blocks-based resume system where different role types use different blocks:

- **SWE block**: technical projects, system design, languages/tools
- **ML/AI block**: models trained, datasets, research, publications
- **Leadership block**: team size, org design, hiring, roadmap ownership
- **Creative block**: portfolio, shipped products, user impact

When we call `/api/tailored-resume`, resume-bot selects and assembles the appropriate blocks for the role, then optionally tailors copy to the specific job description.

---

## Scoring Algorithm (V1)

Scoring runs in our worker at ingest time (or on-demand rescore). Each job gets scored against every profile.

```typescript
function scoreJobAgainstProfile(job: JobPosting, profile: JobProfile): number {
  const signals = {
    title_match:    matchTitleKeywords(job.title, profile.keywords),       // 0.25 weight
    keyword_match:  matchDescriptionKeywords(job.description, profile.keywords), // 0.30
    company_boost:  matchTargetCompanies(job.company, profile.target_companies), // 0.15
    salary_match:   matchSalary(job.salary_min, profile.min_salary),       // 0.15
    remote_match:   matchRemote(job.remote_type, profile.remote_pref),     // 0.10
    seniority_match: matchSeniority(job.experience_level, profile.role_types), // 0.05
  }
  return weightedSum(signals)
}
```

---

## UI Design (V1)

```
┌─ Sidebar ──────────┐ ┌─ Job List ─────────────────────────────────┐
│                    │ │                                              │
│  ● Senior SWE/ML   │ │  [Search]  [Sort: Score ▾]  [Min: 0.7]     │
│  ○ Staff Platform  │ │                                              │
│  ○ Principal/Arch  │ │  ┌─ Job Card ──────────────────────────┐    │
│  ○ Startup Eng     │ │  │ Senior ML Eng · Anthropic · Remote  │    │
│  ○ Creative Writing│ │  │ $200k–$300k · LinkedIn · Score 0.97 │    │
│                    │ │  └─────────────────────────────────────┘    │
│  + New Profile     │ │                                              │
│                    │ │  ┌─ Job Card ──────────────────────────┐    │
└────────────────────┘ │  │ Staff Eng · Google DeepMind · Hybrid │   │
                        │  │ $250k–$350k · Greenhouse · Score 0.94│   │
                        │  └──────────────────────────────────────┘   │
                        └──────────────────────────────────────────────┘
```

Job detail opens in a right-side drawer with full description, score breakdown, and action buttons (greyed for V2+).

---

## Auth

The ingest endpoint (`POST /ingest`) requires a bearer token (`JOBPLATFORM_INGEST_KEY`) set in wrangler secrets — same pattern as hadoku-scrape's `HADOKU_API_KEY`.

The UI is gated by hadoku_site's existing auth layer. No additional auth needed at the worker for read endpoints.

---

## Open Questions

- [ ] **Scraper push vs pull** — confirm with hadoku-scrape team (see scraper prompt)
- [ ] **Auth on read endpoints** — does hadoku_site pass an auth header to the worker, or are read endpoints open?
- [ ] **KV namespace** — shared namespace with other apps or dedicated `JOBPLATFORM_KV`?
- [ ] **resume-bot blocks design** — needs a separate design session with resume-bot
