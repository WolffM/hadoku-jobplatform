# Prompt: Job Platform — Scraper Integration Requirements

Copy-paste this into a conversation with the hadoku-scrape team.

---

Hey — spinning up a new child app (`hadoku-jobplatform`) that will aggregate job postings and give a front-end for reviewing and applying to them. I need your help integrating it into the scraping pipeline.

## What I already know about your stack

Based on the existing codebase I can see:
- You have a FastAPI server with a file-based job queue (`FileJobQueue`)
- You already have job board scrapers for **LinkedIn, Greenhouse, and Lever** under `hadoku_scrape/scrapers/jobboards/`
- You write consolidated scraper output to **Cloudflare KV** (e.g., `recon:{slug}` for the OSS issues pipeline)
- Backfill jobs support **webhook callbacks** (`callback_url` + HMAC signing) when a batch completes
- Config-driven scraping via JSON files in `config/` (e.g., `oss_issues.json` defines 20 projects)
- You already expose `POST /api/v1/jobs` for submitting queue jobs and `GET /api/v1/jobs/{job_id}` for status

I want to follow whatever patterns are already established rather than invent new ones.

## What I need

### 1. Job search config schema

I need to define a `config/jobplatform.json` that tells you what to search for. I'm imagining something like:

```json
{
  "sources": ["linkedin", "greenhouse", "lever"],
  "search_terms": [
    "Senior Software Engineer",
    "Staff Engineer",
    "Principal Engineer",
    "Senior ML Engineer"
  ],
  "locations": ["Remote", "Seattle", "San Francisco"],
  "filters": {
    "experience_levels": ["MID_SENIOR", "DIRECTOR"],
    "job_types": ["FULL_TIME"]
  },
  "schedule": "0 8 * * *",
  "callback_url": "https://hadoku.me/jobplatform/api/ingest"
}
```

**Questions:**
- Does this match your existing job board scraper config shape, or do the LinkedIn/Greenhouse/Lever scrapers expect a different structure?
- Are `experience_levels` and `job_types` values you can filter on at scrape time, or do they have to be post-processed?
- Is there an existing scheduled trigger mechanism for job board scraping (like the `oss-scraper.yml` GitHub Action), or would I need to add one?

### 2. Output data shape

Your `JobListing` schema in `hadoku_scrape/scrapers/jobboards/` looks like it already has the fields I need: `id`, `url`, `source_site`, `title`, `company`, `location`, `job_type`, `workplace_type`, `experience_level`, `salary_info`, `description`, `posted_at`.

**Questions:**
- Is `salary_info` reliably populated across all three sources (LinkedIn, Greenhouse, Lever), or is it sparse? I need to know how much to rely on it for scoring.
- Is `description` the full job description text, or a summary? I need the full text for keyword scoring.
- Do you deduplicate across sources (same role listed on both LinkedIn and Greenhouse)? If not, I'll handle it on my end using the `url` as a unique key.

### 3. Delivery mechanism — push vs. pull

I see two natural options based on your existing patterns:

**Option A — KV write + webhook callback (like your backfill jobs):**
- Scraper writes each job to KV at `jobplatform:raw:{job_id}`
- Scraper calls my `POST /jobplatform/api/ingest` webhook after each batch (HMAC-signed, same pattern as backfill)
- My worker reads from KV on demand for details, but gets notified of new batches in real time

**Option B — Direct push to my ingest endpoint:**
- Scraper calls `POST /jobplatform/api/ingest` directly with job payloads (no KV write)
- Simpler, no KV dependency for this use case
- Payload: `{ jobs: JobListing[], batch_id: string, scrape_run_id: string }`

**My preference is Option A** since it fits your existing backfill pattern and keeps a raw data copy in KV for debugging/reprocessing — but I want to do whatever's less work for you to implement.

Which option would be easier to wire up given your existing architecture? Is there a third option I'm missing that would fit better?

### 4. Auth

Your API requires `HADOKU_API_KEY` as a bearer token. My ingest endpoint will also require a bearer token on the receiving end.

- For Option A: I'll give you a `JOBPLATFORM_INGEST_KEY` secret to include in the webhook callback
- For Option B: Same — you'd include it as `Authorization: Bearer <key>` in the push request

Does that align with how you currently handle outbound auth for webhook callbacks?

### 5. KV namespace

If we go Option A — should job platform data go into the **same KV namespace** as the OSS aggregator data (different key prefixes), or do you prefer a separate `JOBPLATFORM_KV` namespace? The OSS data uses `recon:{slug}:*` keys.

### 6. Trigger / schedule

The OSS issues scraper runs on a scheduled GitHub Action (`oss-scraper.yml`). I'd want job scraping to run daily (same cadence as the old system: `0 8 * * *`).

- Can I add a `job-scraper.yml` workflow on your side that calls your existing API endpoint to trigger a job board scrape?
- Or do you have a built-in cron mechanism I should use instead?

---

## What I'll handle on my end

So you know what's out of scope for you:

- **Scoring** — I'll score jobs against profiles in my Cloudflare Worker, not at scrape time. You just deliver raw job data.
- **Profiles** — I'll manage user role profiles (keywords, target companies, salary filters) in my own storage. The scraper just needs broad search terms.
- **Deduplication across scrape runs** — I'll track `seen_urls` in my DB/KV so the same posting doesn't show up twice across daily runs.
- **Resume/cover letter generation** — handled by resume-bot, no dependency on you.
- **Apply automation** — future concern, will revisit when we get there.

---

## Summary of questions

1. Does my proposed `config/jobplatform.json` schema match your existing job board scraper config, or what shape do they actually expect?
2. Is `salary_info` reliable? Is `description` the full text?
3. Do you deduplicate across sources?
4. Option A (KV + webhook) vs Option B (direct push) — which fits better?
5. Same KV namespace or separate?
6. New `job-scraper.yml` workflow, or existing cron mechanism?
