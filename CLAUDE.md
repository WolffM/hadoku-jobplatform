# Job Platform — Agent Context

## What This Repo Is

Monorepo with two pnpm workspace packages:

- **@wolffm/jobplatform** — React micro-frontend (root `src/`)
- **@wolffm/jobplatform-worker** — Cloudflare Worker API (`worker/src/`)

## Contracts

- **UI**: exports `mount(el)`, `unmount(el)` from `src/entry.tsx` — consumed by hadoku_site at `/jobs/`
- **Worker**: exports `createFetchHandler()`, `createScheduledHandler()` from `worker/src/index.ts` — consumed by `hadoku_site/workers/jobplatform-api/`
- Both publish to GitHub Packages on push to main via `.github/workflows/publish.yml`
- Dispatch: `packages_updated` event notifies hadoku_site to pull new versions and redeploy

## Roadmap (canonical: `ARCHITECTURE.md`)

| Version                        | Status      | Scope                                                                         |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| **V1 — Scrape & Display**      | In progress | Company subscriptions → scrape → ingest → score → browsable UI                |
| **V2 — Triage State**          | Next        | Per-user per-job lifecycle (`interested / dismissed / saved / applied / ...`) |
| **V3 — Tailored Applications** | Deferred    | Resume + cover letter via service binding to resume-api                       |
| **V4 — Auto Apply**            | Deferred    | Automated apply (LinkedIn Easy Apply first, then Greenhouse/Lever/Ashby)      |
| **V5 — Tracking & Follow-ups** | Deferred    | Timeline per application, Kanban view, follow-up dates                        |
| **V6 — Alerts & Digest**       | Deferred    | Daily email / push when new jobs score above per-profile threshold            |

## Worker API (V1 live)

| Method | Path                   | Auth         | Purpose                                                      |
| ------ | ---------------------- | ------------ | ------------------------------------------------------------ |
| POST   | /ingest                | admin/friend | Scraper webhook — receives jobs inline, scores, stores in D1 |
| POST   | /ingest/rescore        | admin/friend | Rescore all jobs against updated profiles                    |
| POST   | /ingest/backfill-slugs | admin/friend | One-off: parse `(ats, slug)` from `job.url` for NULL rows    |
| GET    | /profiles              | open         | List scoring profiles                                        |
| POST   | /profiles              | admin/friend | Create profile                                               |
| PUT    | /profiles/:id          | admin/friend | Update profile                                               |
| GET    | /jobs                  | open\*       | List scored jobs (profile_id, min_score, sort, mine=true)    |
| GET    | /jobs/:id              | open         | Job detail + score breakdown                                 |
| GET    | /companies             | admin/friend | List this user's subscribed companies                        |
| POST   | /companies             | admin/friend | Subscribe; calls scraper /targets + fire-and-forget /search  |
| DELETE | /companies/:id         | admin/friend | Unsubscribe; idempotent on scraper 404                       |
| GET    | /health                | open         | Health check                                                 |

\*`mine=true` requires admin/friend even though the rest of `GET /jobs` is open.

## Key Decisions

- Ingest auth uses standard hadoku auth (`requireUserType` via `X-User-Key`), not a custom secret
- Salary weight is 0.05 — data too sparse to rely on (~5% fill rate)
- Scraper writes raw jobs to KV (`jobplatform:raw:{source}_{job_id}`) for archival/prune, but POSTs **full jobs inline** in the webhook body (not ID-only). Worker scores the inline payload against all profiles and stores matches in D1.
- V1 company-subscription flow (shipped): `POST /companies` → scraper `/targets` → scraper scrapes → webhook fires → jobs land. Scraper owns the resolver/registry; jobplatform owns per-user subscriptions and scoring.
- V1 `(ats, slug)` is derived at ingest time from `job.url` via `worker/src/slugParse.ts` and stored on the `jobs` table (migration 0003). Used by `mine=true` to join jobs against `user_companies`.
- V1 user identity is `sha256(credential).slice(0, 16)` — opaque, stable, raw credentials never enter D1.
- V2 triage state will live in a new `job_states (job_id, user_id, state, notes, updated_at)` table with `UNIQUE(job_id, user_id)`. See ARCHITECTURE.md §"Worker API V2" and §"Data Model — Job States".
- V3 resume-bot integration will use a Cloudflare **service binding** from `hadoku_site/workers/jobplatform-api/` to `hadoku_site/workers/resume-api/`. As of 2026-04-19, `/cover-letter` is verified working end-to-end; `/tailored-resume` is blocked on block seeding in `CONTENT_KV` (verified empty).
- Scheduling is owned upstream: hadoku_site's `mgmt-api` cron dispatches `/api/v1/jobboards/search` on the daily 2am UTC cadence. `createScheduledHandler` in this worker stays a stub.
- Canonical roadmap (V1–V6), full data model, scoring algorithm, and open questions all live in `ARCHITECTURE.md`. Treat it as the north star for any planning work.

## Does NOT

- Bundle react, react-dom, @wolffm/themes (externalized — see `vite.config.ts`)
- Run its own Cloudflare Worker directly (host is in `hadoku_site/workers/jobplatform-api/`)
- Handle scraping (that's hadoku-scrape)
- Handle resume generation (that's resume-bot, planned for V3)

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

## Vault — what your service-tier key can and can't do

This repo's vault key lives in `.devvault.local.json` at the repo root (gitignored, mode 0600). `dev-vault.mjs` reads it automatically. Per-key ACL is enforced as of 2026-05-04.

CAN do (no operator needed):

- `GET /api/secrets/status` — sealed/unlocked check
- `GET /api/secrets/get/:key` — fetch a value declared in this repo's `.devvault.json`
  (other repos' secrets return 403 — your key is scoped to THIS repo)
- `GET /api/secrets/acl/me` — see what your key is granted
- Verify with: `node ../hadoku_site/scripts/secrets/dev-vault.mjs --check`

CANNOT do (returns `403` — by design):

- Read secrets NOT in this repo's `.devvault.json`
- `POST /api/secrets/admin/set-many` — adding/changing secrets
- `POST /api/secrets/admin/lock` — sealing the vault
- `GET /api/secrets/list` — enumerating every secret name
- `GET /api/secrets/audit` — dead-key report

If your code reads a new `process.env.X` that isn't in `.devvault.json` yet:

1. Add the mapping to `.devvault.json` (commit-safe, no values).
2. Tell the operator: they grant the new entries via `key-acl-sync --repo ../<this-repo> --key <uuid> [--prune]`.
3. Re-run your dev command.

Operator-only operations (set / lock / audit / grant) use `HADOKU_ADMIN_KEY`. Don't try to escalate by writing to `ADMIN_KEYS` — service tier can't write.

Lost or rotating your key? Operator: `python scripts/administration.py key-generate --tier service --repo ../<repo> --name <your-name>-<repo>` then drop the new UUID in `.devvault.local.json`.
