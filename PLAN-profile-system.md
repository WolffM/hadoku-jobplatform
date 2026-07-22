# Profile system — per-user job-search profiles

Formalize the job-search "profile" as **per-user** now that friends (not just the
owner) may use it. All profile data is local to a stable user identity; the
default profile is editable by any user, and their edits/deletions persist.

Status legend: ✅ done · 🔨 in progress · ⬜ not started

---

## Foundation (CONFIRMED 2026-07-22)

jobplatform's `profiles` and `user_companies` tables are already correctly
**`X-User-Id` localized** and rotation-safe:

- `worker/src/userId.ts` — `resolveUserId(c)` prefers the edge-injected
  `X-User-Id` header; falls back to `sha256(credential)` only for non-edge callers.
- Every query is scoped `WHERE user_id = ?` (`routes/companies.ts`,
  `routes/profiles.ts`).
- `/jobplatform/api/*` is an edge `injectUserId` route, so `X-User-Id` is always
  present in prod.

### Identity cheat-sheet (ecosystem-wide, from the 2026-07-22 audit)

- **Stable identity** = edge-router registry `userId` (a `crypto.randomUUID()`
  stored in `SESSIONS_KV` `key:{rawKey}`). Carried forward across key rotation by
  mgmt-api (`registry-kv.ts setRegistryUserId`, `key-rotation.ts`).
- It reaches backends **only** as edge-injected `X-User-Id`, **only** on
  `injectUserId` routes.
- `X-User-Key` (the raw credential) **rotates** — never key data on it.
- `sessionId` / `X-Session-Id` (whoami + MFE `userId` mount prop) is **ephemeral**;
  whoami does NOT currently expose the stable userId.
- Key data on **`X-User-Id`**, never on the key or the session.

Mis-keyed apps found (handoffs, not this repo): hadoku-task _preferences_
(X-Session-Id), personal-dataplatform social + watchparty-stats-api (raw
X-User-Key). hadoku_site asks: whoami return userId; flag injectUserId on
dataplatform + watchparty routes.

---

## WS1 — slug pre-fetch / verify & lock

Kills the fuzzy-name first-hit bug (`scale` silently resolving to the wrong
greenhouse board). The operator types slugs, sees the company name + job count +
sample titles per provider, and locks in the confirmed `(ats, slug)`.

### WS1a — scraper `/probe` endpoint ✅ (shipped 2026-07-22, hadoku-scrape main)

`POST /api/v1/jobboards/probe` — body `{slugs: string[], providers?: string[]}`.
Per slug returns `{slug, hits: [{ats, company_name?, n_jobs, sample_titles}]}`.
Read-only; nothing cached or written. Only greenhouse exposes a company name
(via `/v1/boards/{slug}`); ashby/lever return count + titles only.

- `hadoku_scrape/scrapers/jobboards/slug_probe.py` — per-provider body parsers,
  `probe_slugs()`. `MAX_SLUGS=25`, `SAMPLE_TITLES=8`.
- `hadoku_scrape/api/routes/jobboards.py` — `probe_endpoint`, `require_service`.
- 9 respx-mocked unit tests; full jobboards suite (143) green; CI green.

### WS1b — jobplatform verify-and-lock ✅ (this branch)

- `worker/src/clients/scraper.ts` — `probeSlugs()`, `addTargetBySlug()`.
- `worker/src/routes/companies.ts` — new `POST /companies/probe` (proxies scraper
  /probe, admin/friend-gated); `POST /companies` extended with a verify-and-lock
  branch: when `ats`+`slug` are supplied it registers that exact target directly
  (no name resolution) with `display_name` as the operator-confirmed name.
- `worker/src/schemas.ts` — `ProbeCompanySchema`, `ProviderHitSchema`,
  `ProbeCompanyResponseSchema`; `CreateCompanySchema` gains optional `ats`/`slug`.
- `src/api/companies.ts` — `probeSlugs()`, `lockCompany()`.
- `src/components/CompaniesManager.tsx` — collapsible "Verify before subscribing"
  section: probe slugs → per-provider hit cards (ats badge, job count, company
  name, sample titles) → editable display name → "Lock in".
- `user_companies` table already had `ats`/`slug` columns — **zero schema change**.

---

## WS2 — default profile + copy-on-write + tombstone ⬜

Net-new; no such pattern exists in the ecosystem.

- Ship an **editable default profile** any user can see and edit. The owner's
  current hard-coded defaults become the seed.
- On first edit, **copy-on-write** the default into a real per-user row.
- On delete, write a **tombstone** so the default doesn't reappear for that user.
- All keyed by `X-User-Id` (foundation above).

Open design questions: where the default seed lives (KV vs. code constant); how a
tombstoned default is represented (nullable row vs. a `deleted` flag); whether the
default is a real `profiles` row with a reserved id or a synthetic one.

---

## Sequencing & deploy chains

WS1a ✅ → WS1b ✅ → WS2 ⬜.

- **hadoku-scrape**: push main → `ci.yml` (gated on `pytest tests/unit/`) →
  repository_dispatch → PM2 redeploy at scraper.hadoku.me.
- **hadoku-jobplatform**: push main → `publish.yml` (gates: `pnpm run build` +
  `pnpm --filter @wolffm/jobplatform-worker run build`) → GitHub Packages →
  hadoku_site picks up the new @wolffm/jobplatform + worker.
- Auth: jobplatform → scraper uses `X-User-Key: ${SCRAPER_USER_KEY}` (service-tier).

## Cross-repo dependencies (from the identity audit — handoffs, not this repo)

- hadoku_site: make whoami return the stable `userId`; flag `injectUserId` on
  personal-dataplatform + watchparty routes.
- hadoku-task: fix _preferences_ to key on X-User-Id (kickoff prompt drafted).
