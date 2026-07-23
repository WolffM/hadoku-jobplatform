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

## WS2 — default profile + copy-on-write + tombstone ✅ (this branch)

Net-new; no such pattern existed in the ecosystem. Design decisions taken:

- **Seed = code constant** (`worker/src/defaultProfile.ts`, reserved id `default`),
  not KV — versioned, no extra binding. Owner-flavored starting values; any user
  tailors via the UI. Changing the seed does NOT retroactively change users who
  already edited.
- **Copy-on-write**: editing the default (`PUT /profiles/default`) materializes it
  into a real per-user `profiles` row flagged `is_default=1`. Editing an existing
  copy updates it. The reserved id `default` addresses it in the API whether the
  caller sees the seed or their own copy (the real uuid is never exposed).
- **Tombstone**: deleting the default (`DELETE /profiles/default`) removes any COW
  row and writes a `profile_tombstones(user_id, 'default')` row, so the factory
  default never reappears for that user. Editing after deletion resurrects it (COW
  - tombstone cleared).
- **Migration `0006_default_profile.sql`**: additive — `ALTER TABLE profiles ADD
COLUMN is_default` + `profile_tombstones` table + index. Ships with the package;
  the host worker reads `migrations_dir` straight from
  `node_modules/@wolffm/jobplatform-worker/migrations`, so hadoku_site's deploy
  (`wrangler d1 migrations apply jobplatform --remote`) applies it automatically —
  **no hadoku_site change needed**.
- **UI**: `ProfileSidebar` gained an **edit** flow (there was none before — profiles
  were create/select/delete only). `ProfileForm` is now shared between create and
  edit; the default shows a `default` badge; its delete prompt warns it won't come
  back. All keyed by `X-User-Id`.

State machine (all scoped `WHERE user_id=?`): no row + no tombstone → seed · COW
row → edited copy · tombstone → hidden. Verified by reasoning + build; no worker
test harness exists in this repo (established pattern: build-gate + prod
verification). Post-deploy check: GET shows default → PUT edits → GET shows edit →
DELETE → GET omits it.

---

## Sequencing & deploy chains

WS1a ✅ → WS1b ✅ → WS2 ✅.

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
