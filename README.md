# hadoku-jobplatform

An end-to-end job-search pipeline. It pulls postings off company ATS boards, scores
them against role profiles you define, lets you triage what survives, and generates a
tailored resume and cover letter for the ones worth applying to.

Live at **[hadoku.me/jobplatform](https://hadoku.me/jobplatform)** (~7,600 postings in
the corpus as of August 2026). The job list is public; profiles, triage state, and
application packets need an account.

This is one app in the [hadoku.me](https://hadoku.me) ecosystem — a personal platform
where each app ships as an independently versioned npm package and gets mounted by a
parent site. Nothing here runs standalone; see [How it fits together](#how-it-fits-together).

---

## The problem it solves

Job boards rank by recency and their own incentives. Searching them means re-reading
the same 200 postings weekly to find the four that changed. This inverts that: describe
the role you want _once_, and every scrape run re-ranks the whole corpus against it.

Three things make that non-trivial, and most of the interesting code is in the answers:

**No ATS publishes seniority.** Not Greenhouse, not Lever, not Ashby. "Staff Engineer"
vs "Engineering Manager" exists only in the title string. So role is inferred at ingest
([`worker/src/roleClassify.ts`](worker/src/roleClassify.ts)) along **two orthogonal
axes** rather than one list:

- `track` — `ic` or `manager`. Answers "does this job have direct reports?"
- `level` — the rung on that track's ladder.

They're orthogonal because a flat list makes `senior` and `manager` look like
alternatives to each other, which is nonsense — they're answers to different questions.
Classification reads the _head_ of the title, before the first comma, so
"Software Engineer, Ads Manager" correctly lands as an IC. Only the genuinely ambiguous
`lead` family falls back to probing the description body.

**Filtering and ranking are different requests.** "Only show me IC roles" is not "rank
IC roles higher." Company, `track`, and salary floor are **hard SQL filters**; everything
else is a weighted score. Conflating the two produces a feed that's technically sorted
and practically useless.

**Salary is mostly absent.** `salary_min` is NULL on most postings, so scoring it
returned a neutral ~0.5 for nearly everything — pure noise dressed as signal. It was
removed as a score factor and demoted to a view filter. Postings with no listed salary
survive the filter, because hiding them would empty the feed rather than narrow it.

### Scoring

Runs on read, per request — so a score always reflects the profile as it is _now_
rather than as it was when some batch job last ran. (The precomputed match table was
dropped in migration 0008 for exactly this reason.)

| Signal          | Weight | What it measures                            |
| --------------- | -----: | ------------------------------------------- |
| `keyword_match` |   0.40 | profile keywords against the description    |
| `title_match`   |   0.30 | profile keywords against the title          |
| `level_match`   |   0.15 | distance on the seniority ladder            |
| `remote_match`  |   0.15 | remote / hybrid / onsite against preference |

`level_match` grades by _distance_, not equality: exact rung 1.0, one rung off 0.7,
further or off-track 0.2 — and an unclassified job scores 0.5, because no signal is not
the same as a bad match. Full algorithm and data model:
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Architecture

Two independently published packages live in this repo:

| Package                      | Path      | What it is                                      |
| ---------------------------- | --------- | ----------------------------------------------- |
| `@wolffm/jobplatform`        | `src/`    | React micro-frontend, exports `mount`/`unmount` |
| `@wolffm/jobplatform-worker` | `worker/` | Cloudflare Worker API (Hono + D1)               |

The pipeline, end to end:

```
  Profile: keywords, track, levels, remote pref, companies
    │
    ▼
  GET /directives ──────────► hadoku-scrape  (Python, separate repo)
    the union of every            │  resolves company → (ats, slug)
    profile's companies +         │  enumerates Greenhouse / Lever / LinkedIn
    keywords. The scraper         │  archives raw postings to Cloudflare KV
    PULLS this each run.          │
                                  ▼
                          POST /ingest   (full postings inline, batches of 25)
                                  │
                                  ▼
                      ┌───────────────────────────┐
                      │  jobplatform-worker       │
                      │  • dedup by URL           │
                      │  • classify track + level │
                      │  • parse (ats, slug)      │
                      │  • store in D1            │
                      └───────────┬───────────────┘
                                  │  score on read, per request
                                  ▼
                      ┌───────────────────────────┐
                      │  jobplatform (React)      │
                      │  • ranked feed + filters  │
                      │  • triage: interested /   │
                      │    saved / applied / …    │
                      │  • job detail + breakdown │
                      └───────────┬───────────────┘
                                  │  service binding
                                  ▼
                            resume-api  →  tailored resume + cover letter
```

Companies are a **directive the scraper pulls**, not targets this app pushes. The worker
publishes what it wants scraped at `GET /directives`; the scraper reads that on its next
run and registers targets itself. That keeps registry ownership in one place — the
scraper owns _how_ to scrape, this app owns _what_ is worth scraping.

Full API table and design rationale: [`CLAUDE.md`](./CLAUDE.md).

---

## How it fits together

```
hadoku_site  (parent)
  ├── mounts @wolffm/jobplatform          at  hadoku.me/jobplatform
  └── hosts  @wolffm/jobplatform-worker   at  hadoku.me/jobplatform/api
                                                │
                            ┌───────────────────┼───────────────────┐
                            ▼                   ▼                   ▼
                       hadoku-scrape        resume-bot         Cloudflare D1
                       (postings)        (resume/cover)      (scored corpus)
```

Push to `main` publishes both packages to GitHub Packages and fires a
`packages_updated` dispatch; the parent site pulls the new versions and redeploys.

Auth is tier-ranked (`public < friend < service < admin`), gated in-worker. The parent's
edge router resolves a session cookie into a user key and stamps the tier; the worker
trusts that stamp only when its provenance header verifies, so a request that bypasses
the edge degrades to `public` rather than being trusted.

---

## Development

Requires `pnpm`. The dev server needs secrets brokered from the parent repo, so a
standalone clone will build and test but not fully run.

```bash
pnpm install

pnpm dev          # dev server on :5173
pnpm build        # build both packages
pnpm lint         # eslint
pnpm lint:css     # stylelint + theme-token check
pnpm typecheck

cd worker && pnpm test   # node:test, no framework
```

To act as an authenticated user in dev, pass `?apiKey=<key>` once — the harness in
`index.html` exchanges it for a session id through the same code path production uses.
The URL parameter is dev-only and never accepted in production.

**Colors** come from `@wolffm/themes` as semantic CSS custom properties
(`var(--color-primary)`, `var(--color-on-primary-bg)`, …). Light and dark are automatic;
never branch on theme mode, and never hardcode a hex value. `pnpm lint:css` fails the
build on a reference to a token the theme doesn't define — worth running, since an
undefined token renders as nothing rather than erroring.

**Logging** goes through the logger from `@wolffm/task-ui-components`, not `console.log`:

```typescript
import { logger } from '@wolffm/task-ui-components'
logger.info('Message', { key: 'value' })
```

---

## License

[MIT](./LICENSE).
