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

## Worker API (V1)

| Method | Path          | Auth         | Purpose                                                      |
| ------ | ------------- | ------------ | ------------------------------------------------------------ |
| POST   | /ingest       | admin/friend | Scraper webhook — receives jobs inline, scores, stores in D1 |
| GET    | /profiles     | open         | List scoring profiles                                        |
| POST   | /profiles     | admin/friend | Create profile                                               |
| PUT    | /profiles/:id | admin/friend | Update profile                                               |
| GET    | /jobs         | open         | List scored jobs (filter by profile, min_score, sort)        |
| GET    | /jobs/:id     | open         | Job detail + score breakdown                                 |
| POST   | /jobs/rescore | admin/friend | Rescore all jobs against updated profiles                    |
| GET    | /health       | open         | Health check                                                 |

## Key Decisions

- Ingest auth uses standard hadoku auth (`requireUserType` via `X-User-Key`), not a custom secret
- Salary weight is 0.05 — data too sparse to rely on (~5% fill rate)
- Scraper writes raw jobs to KV (`jobplatform:raw:{source}_{job_id}`) for archival/prune, but POSTs **full jobs inline** in the webhook body (not ID-only). Worker scores the inline payload against all profiles and stores matches in D1.
- V1 company-subscription flow (planned): `POST /companies` on jobplatform → calls scraper `POST /api/v1/jobboards/targets` → scraper scrapes → webhook fires → jobs land. Scraper owns the resolver/registry; jobplatform owns the per-user company list and scoring.
- V2 resume-bot integration will use a Cloudflare **service binding** from `hadoku_site/workers/jobplatform-api/` to `hadoku_site/workers/resume-api/` (not HTTPS + key juggling). Resume-bot endpoints (`/tailored-resume`, `/cover-letter`) already exist but are gated by hadoku_site's edge-router `validateFriendOrAdminKey`, and block seeding in `CONTENT_KV` is unverified.
- Full data model and scoring algorithm documented in `ARCHITECTURE.md`

## Does NOT

- Bundle react, react-dom, @wolffm/themes (externalized — see `vite.config.ts`)
- Run its own Cloudflare Worker directly (host is in `hadoku_site/workers/jobplatform-api/`)
- Handle scraping (that's hadoku-scrape)
- Handle resume generation (that's resume-bot, planned for V2)

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
