---
title: Job Platform
summary: >-
  An end-to-end job-search pipeline at
  [hadoku.me/jobplatform](https://hadoku.me/jobplatform): postings are pulled
  from company application boards, scored against role profiles you define,
  triaged, tracked through a Kanban pipeline, and turned into a tailored
  application packet (résumé, cover letter, screening answers) for the ones
  worth applying to. The job feed is open to anyone; an account is needed for
  profiles, triage and packets.
features:
  - name: The feed
    summary: Every scraped posting, ranked against a profile's keywords, seniority and remote preference.
    anchor: the-feed
  - name: Profiles
    summary: Define a role you want — keywords, seniority, remote preference, companies to watch.
    anchor: profiles
    tier: friend
  - name: Triage and the pipeline
    summary: Mark a posting interested, saved or dismissed, then track it through a Kanban to offer or rejection.
    anchor: triage-and-the-pipeline
    tier: friend
  - name: Application packets
    summary: A tailored résumé, cover letter and screening answers for one posting, generated on demand.
    anchor: application-packets
    tier: friend
  - name: The Fill extension
    summary: A Chrome extension that types a packet's answers into the real application form for you to submit.
    anchor: the-fill-extension
    tier: friend
  - name: Insights
    summary: Funnel, response and interview rates, and how your applications are pacing.
    anchor: insights
    tier: friend
trivia:
  - 'The whole first version landed in one commit: 8,158 lines across 38 files (`d846a1d`).'
  - "A profile subscribed to three companies once saw only 953 of 33,103 jobs in the corpus — under 3% of it — because a feed query starved the same job's own detail page sitting beside it: 61,673 rows and 1,975ms on every request, cut to 2,866 rows and 32ms by pinning the join order (`df6d07d`)."
  - "Every identity found sitting in the database resolved, on inspection, to automation or the owner — never a second person — the tell being that only the owner's own rows carry votes or standing answers, things only a human does in a browser (`71e6395`)."
  - 'The busiest day on record is 26 commits, one Wednesday in August (fact sheet, 2026-11-16).'
---

# Job Platform

Job boards rank by recency, not by fit, so finding the handful of postings
that changed means re-reading the same couple hundred every week. Job Platform
inverts that: describe the role you want once, as a **profile**, and every
scrape run re-ranks the whole corpus against it. From there you triage what
survives, track what you apply to, and generate the paperwork for each one —
résumé, cover letter, screening answers — as a single packet.

It lives at [hadoku.me/jobplatform](https://hadoku.me/jobplatform). The feed
is public: anyone can browse scored postings with no account. Profiles,
triage state, the pipeline and application packets need to be signed in at
friend tier or above.

## How a posting gets here

A separate scraper service enumerates company application boards (Greenhouse,
Lever, Ashby) for the companies named across every profile, and posts batches
of full postings to this app's own `/ingest` endpoint. From there Job
Platform owns everything: deduplication, scoring, the UI, triage and the
application packet. The scraper owns only how to fetch a board; this app
decides what is worth fetching and ranks what comes back. See
[contributing.md](contributing.md#architecture) for the pipeline end to end.

## Where to read next

| You want to                      | Read                               |
| -------------------------------- | ---------------------------------- |
| use it                           | [features.md](features.md)         |
| run it, change it, or deploy it  | [contributing.md](contributing.md) |
| how it got from scaffold to here | [history.md](history.md)           |
| the odd facts                    | [trivia.md](trivia.md)             |

The full worker API table and the design decisions behind scoring, roles and
geography live in this repo's own [`AGENTS.md`](../../AGENTS.md) and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) — read those before changing the
scorer or the ingest pipeline.

## Trivia

The full list, each with its source, is in [trivia.md](trivia.md).
