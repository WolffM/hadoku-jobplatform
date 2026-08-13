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
- `src/scoring.ts` — job-profile scoring algorithm (runs on read, per request)
- `src/roleClassify.ts` — infers `(role_track, role_level)` from the title at ingest
- `src/slugParse.ts` — derives `(ats, slug)` from `job.url` at ingest
- `src/userId.ts` — resolves the identity D1 rows are keyed by
- `src/clients/scraper.ts` — typed client for hadoku-scrape
- `src/routes/health.ts` — health check
- `src/routes/ingest.ts` — scraper webhook receiver (reads jobs inline from body, dedups, classifies, stores in D1) + `GET /directives`
- `src/routes/jobs.ts` — job listing queries, triage state, resume/cover-letter binding calls
- `src/routes/profiles.ts` — profile CRUD + each profile's company slice
- `src/routes/companies.ts` — read-only `/companies/match` and `/companies/probe` proxies
- `migrations/` — D1 database migrations

## Auth

Mutation endpoints gate in-worker via `@wolffm/worker-utils` `createEdgeAuth()` +
`requireMinTier('friend')`. Tiers RANK — `public < friend < service < admin` —
so a gate names only the LOWEST tier that should get in and everything above it
is admitted automatically. The scraper's `/ingest` posts and the resume-api
service binding reach these routes by outranking friend, not by being listed;
there is no allowlist to keep in sync. In-handler checks use
`tierAtLeast(auth, tier)` — never an `auth.userType === '...'` comparison, which
is exact-match and would lock those higher tiers out.

The worker trusts the edge-stamped `X-Hadoku-Tier` only when `X-Edge-Auth`
verifies — a direct origin hit degrades to `public`.

## Environment Variables (set in host wrangler.toml)

| Variable           | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `EDGE_AUTH_SECRET` | Edge provenance secret — `createEdgeAuth` verifies inbound X-Edge-Auth |

This worker holds no user keys. edge-router resolves the caller against its KV
key registry and stamps `X-Hadoku-Tier`; the worker trusts that tier only when
the provenance verifies. The `ADMIN_KEYS` / `FRIEND_KEYS` bindings listed here
were retired 2026-07-26 — do not reintroduce them.

## Response Format

Wrapped: `{ success: true, data: {...} }` or `{ success: false, error, message }`
Use `okWrapped()` / `createdWrapped()` from `@wolffm/worker-utils`.

## Does NOT

- Deploy directly (host is `hadoku_site/workers/jobplatform-api/`)
- Handle scraping (see hadoku-scrape)
- Store raw job data long-term (raw data lives in KV; scored data in D1)
