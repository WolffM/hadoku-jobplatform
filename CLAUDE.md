# Job Platform — Agent Context

## What This Repo Is

Monorepo with two pnpm workspace packages:

- **@wolffm/jobplatform** — React micro-frontend (root `src/`)
- **@wolffm/jobplatform-worker** — Cloudflare Worker API (`worker/src/`)

## Contracts

- **UI**: exports `mount(el)`, `unmount(el)` from `src/entry.tsx` — consumed by hadoku_site at `/jobplatform/`
- **Worker**: exports `createFetchHandler()`, `createScheduledHandler()` from `worker/src/index.ts` — consumed by `hadoku_site/workers/jobplatform-api/`
- Both publish to GitHub Packages on push to main via `.github/workflows/publish.yml`
- Dispatch: `packages_updated` event notifies hadoku_site to pull new versions and redeploy

## Roadmap (canonical: `ARCHITECTURE.md`)

| Version                        | Status   | Scope                                                                         |
| ------------------------------ | -------- | ----------------------------------------------------------------------------- |
| **V1 — Scrape & Display**      | Shipped  | Company subscriptions → scrape → ingest → score → browsable UI                |
| **V2 — Triage State**          | Shipped  | Per-user per-job lifecycle (`interested / dismissed / saved / applied / ...`) |
| **V3 — Tailored Applications** | Shipped  | Resume + cover letter via service binding to resume-api                       |
| **V4 — Auto Apply**            | Deferred | Automated apply (LinkedIn Easy Apply first, then Greenhouse/Lever/Ashby)      |
| **V5 — Tracking & Follow-ups** | Deferred | Timeline per application, Kanban view, follow-up dates                        |
| **V6 — Alerts & Digest**       | Deferred | Daily email / push when new jobs score above per-profile threshold            |

## Worker API

Base path `/jobplatform/api` (`createJobPlatformHandler`). Gates are `requireMinTier`,
and tiers RANK (`public < friend < service < admin`) — "friend" admits service and
admin too.

| Method | Path                               | Auth   | Purpose                                                                              |
| ------ | ---------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| GET    | /health                            | open   | Health check                                                                         |
| GET    | /jobs                              | open\* | List jobs (profile_id, min_score, min_salary, sort, state, hide_dismissed)           |
| GET    | /jobs/:id                          | open   | Job detail + score breakdown                                                         |
| GET    | /jobs/preflight                    | open   | "Does this connect to something real?" — registered before /jobs/:id on purpose      |
| PUT    | /jobs/:id/state                    | friend | Set the caller's triage state for one job                                            |
| DELETE | /jobs/:id/state                    | friend | Clear it                                                                             |
| POST   | /jobs/:id/resume                   | friend | Tailored resume via the `RESUME` service binding                                     |
| POST   | /jobs/:id/cover-letter             | friend | Cover letter via the same binding                                                    |
| POST   | /jobs/:id/application-extras       | friend | The non-résumé half of the apply kit (intro email, screening answers, …)             |
| POST   | /jobs/:id/packet-link              | friend | Mint the shareable packet link; its slug is stashed on `job_states.variant_slug`     |
| GET    | /profiles                          | friend | List scoring profiles; materializes the Default profile on first call                |
| POST   | /profiles                          | friend | Create profile                                                                       |
| PUT    | /profiles/:id                      | friend | Update profile                                                                       |
| DELETE | /profiles/:id                      | friend | Delete profile                                                                       |
| GET    | /profiles/:id/companies            | friend | The companies in this profile's slice                                                |
| POST   | /profiles/:id/companies            | friend | Add a confirmed `(ats, slug)` to the slice                                           |
| DELETE | /profiles/:id/companies/:companyId | friend | Remove one                                                                           |
| POST   | /companies/match                   | friend | Read-only proxy to scraper `/match` — name → best board                              |
| POST   | /companies/probe                   | friend | Read-only proxy to scraper `/probe` — verify explicit slugs                          |
| POST   | /ingest                            | friend | Scraper webhook (posts as service) — jobs inline, scored, stored in D1               |
| POST   | /ingest/backfill-slugs             | friend | One-off: parse `(ats, slug)` from `job.url` for NULL rows                            |
| POST   | /ingest/backfill-roles             | friend | Classify `(role_track, role_level)` for pre-0009 rows; `?reclassify=true` redoes all |
| GET    | /directives                        | friend | The scrape directive the scraper PULLS each run (union of profiles' companies)       |

\*`GET /jobs` is open, but `state=` requires friend. `hide_dismissed=` is a no-op
when unauthed rather than an error, so the UI can default it on without a
pre-flight auth check.

## Key Decisions

- Ingest auth uses standard hadoku auth (`requireMinTier('friend')` via `X-User-Key`), not a custom secret
- Salary does not score at all. It's a **view filter + sort** on the feed
  (`min_salary=` / `sort=salary`), never a profile criterion — `salary_min` is
  NULL on most postings, so the old 0.05 factor returned a neutral 0.5 for
  nearly everything. Jobs with no listed salary survive the filter; hiding them
  would empty the feed rather than narrow it.
- **Role = two orthogonal axes, not one list** (migration 0009). `track`
  (`ic | manager | either`) answers "direct reports?" and is a HARD SQL filter
  on `jobs.role_track`; `levels` are rungs on that track's ladder and score by
  distance (exact 1.0 / one rung off 0.7 / else 0.2 / unclassified 0.5). They
  replaced `role_types`, a flat OR-list that mixed the two so that `senior` and
  `manager` were alternatives to each other. `min_salary` and the never-read
  `experience_levels` were dropped in the same migration.
- **No ATS publishes track or level** — not Greenhouse, Ashby, or Lever. Both
  are inferred at ingest by `worker/src/roleClassify.ts` from the title (its
  _head_, before the first comma — "Software Engineer, Ads Manager" is an IC)
  falling back to a description probe for the ambiguous `lead` family only.
  Regression cases: `worker/tests/roleClassify.test.ts`, `pnpm test` in
  `worker/` (node:test, no framework dependency).
- Scraper writes raw jobs to KV (`jobplatform:raw:{source}_{job_id}`) for archival/prune, but POSTs **full jobs inline** in the webhook body (not ID-only). Worker scores the inline payload against all profiles and stores matches in D1.
- **The feed's shortlist is precomputed; its visible score is not** (migration
  0020). `sort=score` orders by `scoreJobLightAxes().bound`, which lived only in
  JS — so SQL could not `ORDER BY` it and the worker read the WHOLE corpus
  (31,748 rows, 14.77MB) to return 25. `job_profile_rank` stores that bound so
  the feed orders and caps in SQL: 386ms/31,748 rows -> 18ms/3,479 rows. The
  description-dependent half of the score is still computed live per request
  over the shortlist, so what the feed DISPLAYS still reflects the profile now.
  Two O(1) markers in `job_profile_rank_state` (a criteria hash, and the highest
  `jobs.rowid` covered) decide whether the stored ranking is trustworthy; when
  it is not, the feed ranks live exactly as before. Absent or stale rank data
  therefore costs latency, never correctness. Rebuild with
  `POST /ingest/rebuild-rank`.
- **Companies are a scrape DIRECTIVE the scraper pulls, not targets we push**
  (migration 0007). The flow is: add `(ats, slug)` to a profile → the scraper
  reads `GET /directives` (the union of every profile's companies + keywords)
  on its next run and registers them itself → webhook fires → jobs land. The old
  push model (`POST /companies` → scraper `/targets`) is retired; its client
  helpers were deleted 2026-08-13. Per-profile `profile_companies` replaced the
  user-global `user_companies`, which survives only as harmless legacy.
- `(ats, slug)` is derived at ingest time from `job.url` via `worker/src/slugParse.ts` and stored on the `jobs` table (migration 0003). It scopes a profile's feed to its companies' jobs.
- V1 user identity is `sha256(credential).slice(0, 16)` — opaque, stable, raw credentials never enter D1.
- V2 triage state lives in the `job_states (job_id, user_id, state, notes, updated_at)` table with `UNIQUE(job_id, user_id)` (migration 0005). See ARCHITECTURE.md §"Worker API V2" and §"Data Model — Job States".
- V3 resume-bot integration (shipped 2026-07-14) uses a Cloudflare **service binding** from `hadoku_site/workers/jobplatform-api/` to `resume-api`. Both `/tailored-resume` and `/cover-letter` are live; blocks are seeded. The binding call stamps `X-Edge-Auth` + `X-Hadoku-Tier: service` to satisfy resume-bot's in-worker gate (added 2026-07-13 — the old "zero-trust binding, no key" assumption is dead).
- Scheduling is owned upstream: hadoku_site's `mgmt-api` cron dispatches `/api/v1/jobboards/search` on the daily 2am UTC cadence. `createScheduledHandler` in this worker stays a stub.
- Canonical roadmap (V1–V6), full data model, scoring algorithm, and open questions all live in `ARCHITECTURE.md`. Treat it as the north star for any planning work.

## Colors

All colors come from `@wolffm/themes` (consumed here as raw CSS `var(--color-*)` in `src/styles/index.css`).
Read `node_modules/@wolffm/themes/THEME_USAGE_GUIDE.md` before writing styles.

- **A token names a semantic role, not a hue.** Light/dark is automatic — never branch on theme mode or `[data-theme]`.
- `<f>` ∈ `primary | success | warning | danger | neutral`. Every family has exactly six tokens: `--color-<f>`, `-dark`, `-bg`, `-hover`, `--color-on-<f>`, `--color-on-<f>-bg`. If a name isn't in that shape, it doesn't exist.
- **Filled surface** → `background: var(--color-<f>)` + `color: var(--color-on-<f>)`. **Tint badge/banner** → `background: var(--color-<f>-bg)` + `color: var(--color-on-<f>-bg)` (NOT `var(--color-<f>)` as text — it fails AA in most themes). **Body text** → `var(--color-text)`. **Card** → `var(--color-bg-card)`. **Border** → `var(--color-border)`.
- **Never** `var(--color-x, #hex)` fallbacks (they hide broken tokens) or hex/`white` literals on a filled background.
- `--color-text-tertiary` / `--color-text-muted` are decorative-only (fail AA on most backgrounds); any text a user must read takes `--color-text` or `--color-text-secondary`.
- Verify with `pnpm run lint:css` (runs stylelint + `check-usage` from the package). A reference to a token the theme doesn't define renders as nothing — the gate is the only thing that catches it.

## Does NOT

- Bundle react, react-dom, @wolffm/themes (externalized — see `vite.config.ts`)
- Run its own Cloudflare Worker directly (host is in `hadoku_site/workers/jobplatform-api/`)
- Handle scraping (that's hadoku-scrape)
- Generate resumes itself (that's resume-bot; jobplatform proxies to it over the `RESUME` service binding as of V3)

## External Dependencies

| Dependency                 | What                                          | Path / Location     |
| -------------------------- | --------------------------------------------- | ------------------- |
| hadoku_site                | Parent site — hosts worker + mounts UI        | `../hadoku_site/`   |
| hadoku-scrape              | Python scraper — writes job data to shared KV | `../hadoku-scrape/` |
| @wolffm/worker-utils       | Auth middleware, response helpers             | npm package         |
| @wolffm/themes             | CSS variables for theming                     | npm package         |
| @wolffm/task-ui-components | UI components and logger                      | npm package         |

## CI/CD

- Push to main -> `publish.yml` builds both packages -> publishes -> dispatches to hadoku_site
- Version bumping: pre-commit hook (`.husky/pre-commit`) + CI fallback
- Required secret: `HADOKU_SITE_TOKEN` (GitHub Packages auth + dispatch)

## Auth & secrets (hadoku ecosystem)

- **Browser fetches** must hit `hadoku.me/{prefix}/*` via edge-router — NEVER `*.hadoku.me` direct subdomains. The `hadoku_session` cookie (`Domain=.hadoku.me`, 30d sliding) is set on `/auth` and resolved server-side by edge-router into `X-User-Key` for the backend.
- **Secrets**: vault-broker model, NO `.env` files. Local dev fetches via `.devvault.json` + `node ../hadoku_site/scripts/secrets/dev-vault.mjs -- <cmd>`. If `pnpm dev` fails, run `node ../hadoku_site/scripts/secrets/dev-vault.mjs --check` for diagnostics. **Tutorial: `../hadoku_site/docs/child-apps/USING_VAULT.md`**. Operational reference: `../hadoku_site/docs/operations/SECRETS.md`.
- **Auth model**: 1:1 named user-keys. `/auth` accepts key + name; whoami returns the name. Admin endpoints `GET/POST/DELETE /session/admin/keys` manage the registry. See `../hadoku_site/docs/planning/next-work.md`.

## Vault — how this repo gets its dev secrets

This repo's vault key lives in `.devvault.local.json` at the repo root (gitignored,
mode 0600); `dev-vault.mjs` reads it automatically. The key is **service tier and
scoped to this repo** — it can read the values declared in `.devvault.json` and
nothing else. Reads of another repo's secrets, and every write/admin operation,
return 403 by design; those are operator-only and there is no self-service path to
them.

Adding a new `process.env.X`: declare the mapping in `.devvault.json` (commit-safe,
names only — no values), then ask the operator to grant it. Diagnose with
`node ../hadoku_site/scripts/secrets/dev-vault.mjs --check`.

Full broker API, ACL commands, and key rotation live in the hadoku_site operational
docs (`docs/child-apps/USING_VAULT.md`, `docs/operations/SECRETS.md`) — deliberately
not mirrored here, since this repo is public.
