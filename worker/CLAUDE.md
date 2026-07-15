# Job Platform Worker

Cloudflare Worker package exporting factory functions for hadoku_site.

## Architecture

- Package: `@wolffm/jobplatform-worker`
- Host worker: `hadoku_site/workers/jobplatform-api/`
- Exports: `createFetchHandler()`, `createScheduledHandler()`, types
- Framework: Hono + `@hono/zod-openapi`

## Key Files

- `src/index.ts` — main exports (factory functions, route mounting)
- `src/types.ts` — AppEnv interface
- `src/schemas.ts` — Zod schemas for OpenAPI validation
- `src/scoring.ts` — job-profile scoring algorithm
- `src/routes/health.ts` — health check
- `src/routes/ingest.ts` — scraper webhook receiver (reads jobs inline from body, scores, stores in D1)
- `src/routes/jobs.ts` — job listing queries
- `src/routes/profiles.ts` — profile CRUD
- `migrations/` — D1 database migrations

## Auth

Mutation endpoints gate in-worker via `@wolffm/worker-utils` `createEdgeAuth()` +
`requireUserType(...)`: most are `['admin','friend']`; `/ingest` and the V3
`/jobs/:id/{resume,cover-letter}` also admit `'service'` (scraper posts / the
resume-api service binding). The worker trusts the edge-stamped `X-Hadoku-Tier`
only when `X-Edge-Auth` verifies — a direct origin hit degrades to `public`.

## Environment Variables (set in host wrangler.toml)

| Variable      | Description                   |
| ------------- | ----------------------------- |
| `ADMIN_KEYS`  | JSON array of admin API keys  |
| `FRIEND_KEYS` | JSON array of friend API keys |

## Response Format

Wrapped: `{ success: true, data: {...} }` or `{ success: false, error, message }`
Use `okWrapped()` / `createdWrapped()` from `@wolffm/worker-utils`.

## Does NOT

- Deploy directly (host is `hadoku_site/workers/jobplatform-api/`)
- Handle scraping (see hadoku-scrape)
- Store raw job data long-term (raw data lives in KV; scored data in D1)
