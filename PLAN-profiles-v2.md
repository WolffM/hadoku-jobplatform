# Profiles v2 — optional filters, unified editor, real scoring

Scoping doc for the 2026-07-24 round of feedback. Status: **DRAFT — decisions open.**

---

## Findings (observed in prod D1, not assumed)

Queried the live `jobplatform` D1 with wrangler:

| table | count | meaning |
| --- | --- | --- |
| `jobs` | ~5,400 | scraped corpus |
| `profile_companies` | 9 | default profile's seed companies ✅ |
| `job_profile_matches` | **0** | **no precomputed scores exist → every score renders 0.00** |
| `job_states` | 2 | triage **works** — clicks are stored, keyed by stable `X-User-Id` ✅ |

**Scoring 0.00 root cause:** scores are precomputed per `(job, profile)` into `job_profile_matches`, populated (a) at ingest and (b) by a one-time backfill when a profile is created. Both missed: jobs were ingested when there were **no profiles**, and the backfill rescore (`rescore.ts`, runs once in a `waitUntil` over *all* ~5,400 jobs loaded at once) is failing — almost certainly a D1 result-size / Worker-memory limit loading every description into memory — then it's caught, logged, and **never retried**.

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

## Proposed model

**Corpus (global scan), decoupled from profiles.** Scan a broad, regularly-refreshed base set of companies **plus** the union of everything anyone pins — so a keyword-only profile has real breadth to filter. Scanning is no longer owned by a single profile.

**A profile = a saved filter preset. Every component optional:**

- **Companies** (optional): restrict to these; empty ⇒ the whole corpus.
- **Keywords** (optional): match/rank; empty ⇒ no keyword constraint.
- **Titles / role types** (optional): the seniority picker.
- **Salary, remote** (optional).
- An empty profile ⇒ everything, newest first.

Examples this enables: "all software-engineer jobs, any company" (keyword-only); "all Anthropic jobs, no filters" (company-only). Caveat: "all Microsoft jobs" needs a Workday scraper (not on greenhouse/lever/ashby) — separate track.

---

## Workstreams

### WS1 — Make scoring actually work

The precompute-everything approach is the thing that broke. Options:

- **A. Score-on-read (recommended).** Drop `job_profile_matches` as the ranking source. In the jobs query, pull the filtered candidate set (already narrowed by companies/keywords/etc.) and score those rows in JS in-request, then sort + paginate. Always reflects current criteria, no rescore, no staleness. Cap the candidate set (e.g. 2–3k) and fall back to recency beyond it.
- **B. Keep precompute, fix reliability.** Chunk the rescore (paged reads, batched writes), make it retryable, trigger it on profile create/edit and via cron. More moving parts; scores go stale between rescans.
- **C. SQLite FTS5 for keywords.** Index title/description; let SQLite rank keyword relevance in SQL over the whole corpus. Best for "keyword over everything"; more schema.

Recommendation: **A** for correctness now, consider **C** later if keyword-over-everything is slow.

### WS2 — Optional filters + decoupled scanning

- Companies on a profile become an **optional filter** (empty = all corpus), not a required scope. Feed query: only add the `profile_companies` join when the profile actually has companies.
- Keywords/roles/salary/remote already degrade to neutral; make sure "none set" = no filter (not a 0 score).
- **Base scan set**: introduce a curated global company list (admin-seeded) scanned on the daily cron regardless of profiles, so keyword-only profiles have a corpus. *(Decision: size / how curated — see below.)*

### WS3 — Scanning breadth (depends on WS2 decision)

If we want keyword-only profiles to be genuinely useful, grow the scanned corpus well beyond today's 9 targets — a curated few-hundred-company base list across greenhouse/lever/ashby, refreshed on the cron. This is the "scan regularly, filter by keyword" idea.

### WS4 — Unified full-screen profile editor

Replace the sidebar mini-form **and** the separate companies panel with one **full-screen modal (≈80%, dimmed backdrop)** holding every profile component in one place:

- **Name**
- **Keywords** — nicer chip input (not the current cramped box), each with a live **preflight**: "N matching jobs in the corpus."
- **Titles / role types** — picker, with a preflight count per selection.
- **Companies** — the name→match→confirm flow inline, plus the current list; per-add preflight already exists (job count).
- **Salary, remote**.

Every section's **preflight probe** answers "does this connect to something real?" against live data (keyword→job count, title→job count, company→match). Kills the "Know the exact slug" panel entirely.

---

## Open decisions

1. **Scoring approach** — A (score-on-read, recommended) / B (fix precompute) / C (FTS)?
2. **Base scan set** — add a curated global company list so keyword-only profiles have breadth? If yes, roughly how big / who curates (admin-seeded vs auto-discover)?
3. **Companies** — confirm they stay as an *optional per-profile filter* (not removed, not required).
4. **Editor scope** — full replacement of the sidebar form + companies panel in one modal, or incremental?

---

## Sequencing (once decided)

WS1 (scoring) is the highest-value fix and mostly independent → do first. WS2 (optional filters) is small and unblocks the model. WS4 (editor) is the big UI piece. WS3 (scan breadth) can trail. All ship via the usual jobplatform publish → hadoku_site deploy (migrations auto-apply).
