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
- `src/rank.ts` — the light-pass bound, precomputed into `job_profile_rank` so
  the feed can `ORDER BY` / `LIMIT` in SQL instead of reading the whole corpus.
  Writing it is the only new thing; the number is the same one `scoring.ts`
  produces. `rankIsCurrent()` is what the feed asks before trusting it.
- `src/roleClassify.ts` — infers `(role_track, role_level)` from the title at ingest
- `src/slugParse.ts` — derives `(ats, slug)` from `job.url` at ingest
- `src/userId.ts` — resolves the identity D1 rows are keyed by
- `src/clients/scraper.ts` — typed client for hadoku-scrape
- `src/routes/health.ts` — health check
- `src/routes/ingest.ts` — scraper webhook receiver (reads jobs inline from body, dedups, classifies, stores in D1) + `GET /directives`
- `src/routes/jobs/` — job listing queries, triage state, resume/cover-letter binding calls:
  - `index.ts` — assembles the sub-app. **Registration order is load-bearing** —
    `/jobs/preflight` must register before the `/jobs/{id}` param route or the
    param route captures "preflight" as an id. Don't reorder.
  - `shared.ts` — `maybeUserId`, the `gateAuthed` friend-tier middleware, and the
    `asRoleLevel`/`asRoleTrack` narrowers for D1's plain-TEXT columns
  - `feed.ts` — `GET /jobs`: the SQL-paginated path, and the score-on-read path
    in its two forms — ranked in SQL when `job_profile_rank` is current, ranked
    live over the corpus when it is not
  - `preflight.ts` — `GET /jobs/preflight` editor probe
  - `detail.ts` — `GET /jobs/{id}`
  - `state.ts` — `PUT`/`DELETE /jobs/{id}/state` (V2 triage)
  - `tailoring.ts` — the four V3 proxies over the `RESUME` service binding
- `src/routes/profiles.ts` — profile CRUD + each profile's company slice
- `src/routes/companies.ts` — read-only `/companies/match` and `/companies/probe` proxies
- `migrations/` — D1 database migrations
- `tests/helpers/harness.ts` — integration harness: real D1 via Miniflare/workerd
  with every migration applied, the real edge-auth middleware, and a real
  loopback HTTP server standing in for the resume-api binding

## Tests

`pnpm test` in `worker/` (node:test, no framework dependency). `tests/*.test.ts`
are unit tests over the leaf modules; `tests/routes/*.test.ts` drive the whole
assembled worker through `createJobPlatformHandler` against a real database.

Note for anything importing worker source from a test: node runs `.ts` with
**strip-only** type stripping, which rejects TypeScript parameter properties and
enums outright. Keep src free of both, or nothing past a leaf module can be
imported.

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
