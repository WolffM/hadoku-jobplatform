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

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /ingest | admin/friend | Scraper webhook — fetches jobs from KV, scores, stores in D1 |
| GET | /profiles | open | List scoring profiles |
| POST | /profiles | admin/friend | Create profile |
| PUT | /profiles/:id | admin/friend | Update profile |
| GET | /jobs | open | List scored jobs (filter by profile, min_score, sort) |
| GET | /jobs/:id | open | Job detail + score breakdown |
| POST | /jobs/rescore | admin/friend | Rescore all jobs against updated profiles |
| GET | /health | open | Health check |

## Key Decisions

- Ingest auth uses standard hadoku auth (`requireUserType` via `X-User-Key`), not a custom secret
- Salary weight is 0.05 — data too sparse to rely on (~5% fill rate)
- Scraper writes raw jobs to KV (`jobplatform:raw:{source}:{job_id}`), sends lightweight webhook with `job_ids[]`
- Worker fetches full records from KV, scores against all profiles, stores matches in D1
- Full data model and scoring algorithm documented in `ARCHITECTURE.md`

## Does NOT

- Bundle react, react-dom, @wolffm/themes (externalized — see `vite.config.ts`)
- Run its own Cloudflare Worker directly (host is in `hadoku_site/workers/jobplatform-api/`)
- Handle scraping (that's hadoku-scrape)
- Handle resume generation (that's resume-bot, planned for V2)

## External Dependencies

| Dependency | What | Path / Location |
|------------|------|-----------------|
| hadoku_site | Parent site — hosts worker + mounts UI | `../hadoku_site/` |
| hadoku-scrape | Python scraper — writes job data to shared KV | `../hadoku-scrape/` |
| @wolffm/worker-utils | Auth middleware, response helpers | npm package |
| @wolffm/themes | CSS variables for theming | npm package |
| @wolffm/task-ui-components | UI components and logger | npm package |

## CI/CD

- Push to main -> `publish.yml` builds both packages -> publishes -> dispatches to hadoku_site
- Version bumping: pre-commit hook (`.husky/pre-commit`) + CI fallback
- Required secret: `HADOKU_SITE_TOKEN` (GitHub Packages auth + dispatch)
