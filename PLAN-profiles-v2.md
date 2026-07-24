# Profiles v2 — optional filters, unified editor, real scoring

Scoping doc for the 2026-07-24 round of feedback. Status: **DRAFT — decisions open.**

---

## Findings (observed in prod D1, not assumed)

Queried the live `jobplatform` D1 with wrangler:

| table                 | count  | meaning                                                              |
| --------------------- | ------ | -------------------------------------------------------------------- |
| `jobs`                | ~5,400 | scraped corpus                                                       |
| `profile_companies`   | 9      | default profile's seed companies ✅                                  |
| `job_profile_matches` | **0**  | **no precomputed scores exist → every score renders 0.00**           |
| `job_states`          | 2      | triage **works** — clicks are stored, keyed by stable `X-User-Id` ✅ |

**Scoring 0.00 root cause:** scores are precomputed per `(job, profile)` into `job_profile_matches`, populated (a) at ingest and (b) by a one-time backfill when a profile is created. Both missed: jobs were ingested when there were **no profiles**, and the backfill rescore (`rescore.ts`, runs once in a `waitUntil` over _all_ ~5,400 jobs loaded at once) is failing — almost certainly a D1 result-size / Worker-memory limit loading every description into memory — then it's caught, logged, and **never retried**.

**Triage:** confirmed working and persisted. No work needed.

---

## The asks

1. **Remove "Know the exact slug"** — annoying. → subsumed by the unified editor (WS4); the whole `CompaniesManager` panel is replaced.
2. **Do we even need users to input companies?** → No — decouple scanning from profiles (WS2).
3. **Scoring shows 0.00** → fix score population (WS1).
4. **Do triage steps work / is data stored?** → **Yes** (verified). No change.
5. **Point of separate profiles / make all components optional** → profiles become saved filter presets, every part optional (WS2).
6. **(mid-turn) Keywords UI is ugly; company UI not unified with profile UI; want a full-screen (80%, dimmed) profile editor with all sections in one place, each with its own preflight probe** → WS4.

---

## Model (LOCKED 2026-07-24)

**Profile inputs ARE scrape directives** — what you put in a profile is what gets scraped, and the profile then filters/ranks the results.

- Each **company** on a profile → an ATS board target (greenhouse/lever/ashby), scraped on cron. Works today.
- Each **keyword** on a profile → a search query run against **keyword-searchable providers**, scraped on cron.

All results flow into one shared corpus (union of every profile's directives). A profile's feed = the corpus filtered/ranked by ITS companies + keywords. Every profile component is **optional**: companies empty ⇒ all corpus; keywords empty ⇒ no keyword constraint; empty profile ⇒ everything, newest first.

Examples: "all software-engineer jobs, any company" = keyword-only; "all Anthropic jobs" = company-only.

### Keyword sources (LOCKED)

ATS APIs (greenhouse/lever/ashby) CANNOT be keyword-searched — only per-company boards. LinkedIn (our only search-based provider) is **dead since 2026-05-03** and is **parked** for now. New keyword-searchable providers, all verified live 2026-07-24:

- **Phase 1 — keyless (ship first):** Remotive (`?search=`), The Muse (`category=/level=/location=`), RemoteOK (tag/JSON feed). No credentials, remote/tech-focused. (Feed ads/junk irrelevant — we ingest structured postings and re-rank ourselves.)
- **Phase 2 — breadth (one free key):** Adzuna (`?what=&where=`, large corpus). Makes "all X jobs" genuinely broad.
- **Parked:** LinkedIn (re-add later as just another provider); avoid direct Indeed/Google HTML scraping (bot-detection, ToS).

Caveat: "all Microsoft jobs" needs a Workday scraper (not on any current provider) — separate track.

---

## Workstreams

### WS1 — Make scoring actually work

The precompute-everything approach is the thing that broke. Options:

- **A. Score-on-read (recommended).** Drop `job_profile_matches` as the ranking source. In the jobs query, pull the filtered candidate set (already narrowed by companies/keywords/etc.) and score those rows in JS in-request, then sort + paginate. Always reflects current criteria, no rescore, no staleness. Cap the candidate set (e.g. 2–3k) and fall back to recency beyond it.
- **B. Keep precompute, fix reliability.** Chunk the rescore (paged reads, batched writes), make it retryable, trigger it on profile create/edit and via cron. More moving parts; scores go stale between rescans.
- **C. SQLite FTS5 for keywords.** Index title/description; let SQLite rank keyword relevance in SQL over the whole corpus. Best for "keyword over everything"; more schema.

**DECIDED: A (score-on-read).** Simplest correct fix, no rescore/staleness, always reflects current criteria. Consider C (FTS) later only if keyword-over-everything gets slow. Drop `job_profile_matches` + the `rescore.ts`/ingest-scoring machinery.

### WS2 — Optional filters + decoupled scanning

- Companies on a profile become an **optional filter** (empty = all corpus), not a required scope. Feed query: only add the `profile_companies` join when the profile actually has companies.
- Keywords/roles/salary/remote already degrade to neutral; make sure "none set" = no filter (not a 0 score).
- **Base scan set**: introduce a curated global company list (admin-seeded) scanned on the daily cron regardless of profiles, so keyword-only profiles have a corpus. _(Decision: size / how curated — see below.)_

### WS3 — Keyword-source scrapers (the breadth)

Add keyword-search providers to the scraper orchestrator (same shape as the old LinkedIn branch: search term in → normalized `JobListing`s out → shared corpus). Phase 1: Remotive + The Muse + RemoteOK (keyless). Phase 2: Adzuna (free key). Profile keywords (union across profiles) become the search terms fed to these on the cron. This replaces the old "curated broad base company list" idea — keyword searches generate the breadth instead.

### WS4 — Unified full-screen profile editor

Replace the sidebar mini-form **and** the separate companies panel with one **full-screen modal (≈80%, dimmed backdrop)** holding every profile component in one place:

- **Name**
- **Keywords** — nicer chip input (not the current cramped box), each with a live **preflight**: "N matching jobs in the corpus."
- **Titles / role types** — picker, with a preflight count per selection.
- **Companies** — the name→match→confirm flow inline, plus the current list; per-add preflight already exists (job count).
- **Salary, remote**.

Every section's **preflight probe** answers "does this connect to something real?" against live data (keyword→job count, title→job count, company→match). Kills the "Know the exact slug" panel entirely.

---

## Decisions (LOCKED 2026-07-24)

1. **Scoring** — score-on-read (A). Drop job_profile_matches.
2. **Model** — profile inputs are scrape directives (company→board, keyword→search provider); corpus = union of all directives; profile filters/ranks it.
3. **Keyword sources** — Remotive + The Muse + RemoteOK (keyless, phase 1) → Adzuna (free key, phase 2); LinkedIn parked.
4. **Companies** — stay as an optional per-profile filter (not removed, not required).
5. **Editor scope** — full replacement of the sidebar form + companies panel with one dimmed ~80% modal, each section with a preflight probe.

---

## Sequencing

1. **WS1 — score-on-read** ✅ SHIPPED 2026-07-24 (worker 1.1.8, migration 0008). Feed scores compute in-request; `job_profile_matches` + rescore machinery dropped. Confirmed non-zero scores in prod.
2. **WS2 — optional filters** ✅ SHIPPED 2026-07-24. `profile_companies` join is now conditional — a profile with no companies scores the whole corpus (capped, most-recent first); with companies it scopes to them. The profile form already made keywords/roles/salary/remote optional (only `name` required), so no UI change was needed.
3. **WS3 — keyword-source scrapers** (Remotive/Muse/RemoteOK → Adzuna) so keyword profiles have real jobs.
4. **WS4 — unified full-screen editor** with per-section preflight probes.

All ship via the usual jobplatform publish → hadoku_site deploy (migrations auto-apply); WS3 is scraper-side (push main → CI → PM2).
