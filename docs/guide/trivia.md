# Job Platform: trivia

The best facts about Job Platform, each with its source.

## Beginnings and quiet spells

- The whole first version — the React app and the Cloudflare Worker both —
  landed in a single commit of 8,158 lines across 38 files (`d846a1d`).
- The longest stretch with no commit from a person is 16 days, bridged only
  by the weekly `@wolffm/*` auto-update bot (`20ab57a` → `acc14da`,
  2026-06-16 to 2026-07-02).
- `src/prefs/` lived 75 days as its own directory — persisting the theme
  choice through a shared preferences client — before folding into the
  platform's shared theme root (`56015f7` → `3a0e440`).

## Scale and shape

- 542 commits over 236 days of this repo's life have landed on 118 distinct
  days; the busiest, one Wednesday in August, saw 26 (fact sheet,
  2026-11-16).
- The most-rewritten file is `worker/src/schemas.ts` at 47 commits — every
  new field, every new route, touches its validation (fact sheet,
  2026-11-16).

## Decisions

- Subscribing a profile to a company used to scope the whole feed to just
  that company: three subscribed companies meant three companies visible,
  953 of 33,103 jobs. That same narrow scope, read concurrently with a job's
  own detail page, starved it: 2.3 seconds for a 200ms lookup, because the
  feed beside it was walking 61,673 rows at 1,975ms every request. Pinning
  the join order fixed the drawer at 2,866 rows and 32ms (`df6d07d`).
- A feed read by a service identity acting for a person once silently
  dropped who it was reading for, scoring the feed against the service
  identity's own (empty) application history instead. A route that ignores
  this answers for an identity that owns nothing, and nothing errors to say
  so. `GET /jobs` carried exactly that bug before being fixed (`fbf59d2`).
- Every identity found sitting in the database was, on inspection, automation
  or the owner — never a second person. The tell: only the owner's own rows
  carry votes or standing answers, things only a human does in a browser
  (`71e6395`).

## Trivia

Four of these are on the wiki's own page for this repo, from the front
matter of [index.md](index.md).
