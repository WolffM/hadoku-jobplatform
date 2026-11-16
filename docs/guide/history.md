# Job Platform: history

How Job Platform got from an empty scaffold to a full apply pipeline, told as
a roadmap of six versions (V1–V6) rather than a changelog. The roadmap itself
is tracked in this repo's own [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Scaffold and V1 — scrape, score, browse (March–April 2026)

The whole first version landed in a single commit: 8,158 lines across 38
files, both the React app and the Cloudflare Worker at once (`d846a1d`,
2026-03-24). V1 closed a month later: per-user scoring profiles and the job
browser UI, against postings already arriving from the scraper
(`c2bd4e2`, 2026-04-19).

## V2 — triage state (April 2026)

Nine days after V1, every posting got a per-user lifecycle —
interested/dismissed/saved/applied/offered/rejected — so a dashboard visit
would not re-surface the same postings looked at yesterday
(`473b63f`, 2026-04-30; migration 0005).

## V3 — tailored applications (July 2026)

A per-job tailored résumé and cover letter, generated through a secured call
to a separate résumé-building service and surfaced as a **Generate packet**
button on the job drawer, shipped on 2026-07-14 (`a6595c0`). Within two weeks
the tier checks that gate it were rewritten from an allowlist to a tier
hierarchy — `public < friend < service < admin`, where naming the lowest
admits everything above it (`aa4b10e`, 2026-07-25). The generated packet's
shareable link was then given a durable home on the triage row itself, so
the record of what was actually sent survives a later edit
(`d2a6322`; migration 0010).

## Cleanup and reliability (August 2026)

August rebuilt the foundations under everything above. The UI dropped its
own copies of the platform's theme machinery for a shared theme root
(`3a0e440`, 2026-08-05) — the busiest day on record, 26 commits. A week later
a dead surface flagged by an automated code-quality pass was removed
(`56c8b01`, 2026-08-13). Then one day, 2026-08-17, split both the giant
stylesheet and the giant `jobs.ts` route file into one piece per concern and
added an 81-test integration harness over the result (`e96cb2e`, `3ea5adc`,
`bce1f9c`). A week after that, git hooks — which worktrees were silently
skipping because they lived outside any tracked directory — moved somewhere
every worktree would actually run them (`dd61ee6`, 2026-08-24).

## A hard scope, and the drawer it starved (September 2026)

Subscribing a profile to a company used to be a hard scope: only postings
from subscribed companies were shown at all, which for a three-company
profile meant 953 of 33,103 jobs. That narrow scope had a second cost: a
job's own detail page, read at the same time as the feed beside it, took
2.3 seconds for a 200ms lookup, because the feed's query was walking 61,673
rows at 1,975ms on every request. Pinning the join order that the company
scope depended on cut the drawer to 2,866 rows and 32ms (`df6d07d`,
2026-09-08). Companies are a directive the scraper pulls today, not a feed
filter — see [contributing.md](contributing.md#architecture) — and every
posting in the corpus competes on a profile's criteria alone.

## Auto-apply and the Fill extension (October 2026)

An applicant profile (contact details, education, work history) and
"fill packets" built for filling forms in the owner's own browser arrived
first (`d50a5c1`), then the Fill extension itself. It reached the dashboard
as an install prompt and an **Open form** shortcut straight to the page it
fills (`2f26a0e`, `774779c`). Then came **send sessions** that fill and
advance through every ready application in one sitting, leaving Submit and
any verification code to the owner — by design, since that step is exactly
what tells a board a person is there (`caa80c5`, 2026-10-07).

## Tracking, geography and the pipeline merge (November 2026)

November added where a posting actually is — matched against the places its
own location text names, not a geocoder — as a feed filter (`d7b0623`,
2026-11-06; migration 0030). The next day, triage grew into a full pipeline:
interviewing/offered/rejected states, notes, priority, a follow-up date and a
Kanban board (`6e8fced`, `c09851e`, 2026-11-07; migration 0028). Two days
later, an outside contributor's job-tracker UI started shipping as a
second, published front end on this app's own worker API, built from a
pinned commit of its own upstream repo (`7914685`, 2026-11-09). The same
day, the `@wolffm/*` dependencies switched from a private registry to their
public npm mirrors (`a1af6b1`).

## Removed along the way

| What                                                    | Added          | Removed   | Why                                                                                                                                      |
| ------------------------------------------------------- | -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `role_types` (one flat seniority list)                  | the scaffold   | `80fe26f` | `senior` and `manager` read as alternatives to each other, which is nonsense — split into orthogonal `track` + `levels` (migration 0009) |
| Precomputed `job_profile_matches` table                 | the scaffold   | `92b358a` | scoring moved on-read so a score always reflects the profile now                                                                         |
| User-global company subscriptions (`user_companies`)    | migration 0002 | `6bd007d` | superseded by per-profile `profile_companies` in migration 0007                                                                          |
| Scraper-push client helpers (`addTargetsByName` et al.) | the scaffold   | `56c8b01` | companies became a directive the scraper pulls, not a target pushed                                                                      |
| `experience_levels` column                              | the scaffold   | `80fe26f` | round-tripped on every read and write since the scaffold, never read by the scorer                                                       |

## Trivia

A route that silently ignored who it was acting for would answer for the
SERVICE identity instead — which owns nothing — so every per-user check on
that read evaluated against nobody, and nothing errored to say so. `GET
/jobs` was exactly that bug (`fbf59d2`). A month later, acting on someone
else's behalf at all was narrowed from every service key in the fleet down
to admins and a short, named list of callers, each checked against the key
registry rather than trusted from the request alone (`f9a4db4`).
