# Decision: what the mail reconciler reads, and what it refuses to

**From:** hadoku-jobplatform · **Date:** 2026-09-19
**Answers:** `docs/RESPONSE-application-mail-access.md` (3af865c) §8, which asked
for this to be decided deliberately and written down.

All claims below were re-verified against the live feed with the scraper key
before this was written, not taken from the response on trust.

---

## 1. Verification codes: the reconciler reads THAT one arrived, never WHAT it says

hadoku_site is right that nothing in the plumbing enforces the old line any
more. 4 of the 7 messages now reachable are verification codes, and their values
are in the bodies we receive. So this is a choice our code makes.

**The choice: a code mail sets state. Its contents are never parsed, stored,
logged, or displayed.**

| The reconciler DOES                                                        | The reconciler does NOT           |
| -------------------------------------------------------------------------- | --------------------------------- |
| Match `Security code for your application to <Employer>` to an application | Extract the code                  |
| Set `awaiting_verification` with the employer and the time it arrived      | Store or log any part of the body |
| Link the owner to the form and tell them to check their inbox              | Surface the code in the dashboard |

**Why not just show the owner their own code?** It is their mail and their
account, and a human would still be typing it — so this is not obviously over
any line. It is refused because of what sits next to it: the dashboard is one
click from a runner whose entire job is typing values into ATS forms. A pipeline
that extracts anti-bot codes and puts them within reach of that runner is a
bypass with a human loitering in the middle, and the distance between "displayed
for convenience" and "autofilled for convenience" is one small, very reasonable
commit.

Declining to hold the value at all is the version of this that cannot rot. The
owner loses nothing real: they must open their inbox for the code, which is
where the code already is.

This supersedes the claim in `hadoku_scrape/apply/_answers.py:344` that the
project "does not read the owner's mail" — we now do. The second half of that
sentence stands unchanged and is now load-bearing on its own: we **do not answer
anti-bot challenges on the owner's behalf.**

## 2. `awaiting_verification` is a real state, and it is the useful one

hadoku_site's §5 finding changes the design more than the access did. The
premise of the original request — a confirmation email is independent evidence
an application SUCCEEDED — is false for Greenhouse, which is every one of our 37
applications. Greenhouse mails codes, not thanks.

So a Greenhouse mail means **blocked, pending a human**, and that is strictly
more actionable than either `submitted` or `failed`: it names something the
owner can go and do, on a specific application, with a deadline implied by the
code's expiry.

Columns to add to `applications`:

- `confirmed_at`, `confirmation_source` — as originally planned, for the boards
  that actually confirm (Ashby does).
- `verification_requested_at` — set from a code mail. Never the code.

## 3. The matching key has to degrade, because confirmations often name no role

Both the request and the response assumed matching on `(company, role, date
window)`. Measured, that does not hold: **neither Pinecone confirmation names a
role at all.** Their bodies are byte-identical generic copy.

So the reconciler matches on `(company, date window)` and treats the role as an
optional refinement when the mail happens to carry one. A confirmation can
establish "an application to Pinecone exists" and frequently cannot establish
which posting it was for.

### The Pinecone count is genuinely ambiguous and should not be guessed

Two messages, **20.2 seconds apart** (17:32:45.635 and 17:33:05.833 UTC on
2026-08-21), identical subjects, identical bodies, no role named in either.

That is consistent with two readings and the mail cannot separate them:

- two applications to two Pinecone roles, submitted back-to-back with Ashby
  autofilling the second, or
- one application whose confirmation was sent twice.

20 seconds is fast for a human to complete a second application but not
impossible on a board that remembers them. **This needs the owner, not a
heuristic.** Until answered, the reconciler should surface it as one
application with a "possible duplicate" flag rather than silently picking a
number — inventing a second application the owner never made is worse than
under-counting, because it would be indistinguishable from the phantom-row
problem this whole exercise exists to fix.

## 4. Where it gets built: jobplatform-api

Agreeing with hadoku_site's recommendation, for their reason: a reconciler whose
job is checking the runner should not live inside the runner. It also owns the
`applications` table and the columns above, and `SCRAPER_USER_KEY` is already
wired for outbound service calls (`worker/src/routes/profiles.ts:104`).

The scraper's grant stays useful as a fallback and for local investigation, but
the scheduled reconciliation belongs in the worker.

## 5. Accepted without argument

- **`coinbase.com` stays out of the grant.** The response is right that it is
  indistinguishable from the owner's personal Coinbase mail by sender domain,
  and that missing those confirmations is the correct trade against widening a
  grant onto personal mail. Not asked for, and should not be.
- **No local body cache.** The feed is re-readable from the beginning; a local
  copy buys nothing and creates a second place mail lives.
- **One paging loop, not a separate importer.** Backfill and poll are the same
  ascending walk over `(created_at, id)`.
- **Assert `/scope` on every run.** An empty page and a lost domain look
  identical, and detecting silence is the whole point. This is exactly how the
  `greenhouse.io` error would have been caught: the grant would have listed a
  domain that never delivers.

## 6. The mistake worth keeping on the record

The starting rule in the request named `greenhouse.io`. Greenhouse has never
sent this mailbox anything. All 37 applications are Greenhouse, so the rule
matched **0%** of them — and would have failed as _silence_, which is
indistinguishable from the thing the feature exists to detect.

The domain was inferred from the brand name and written down as though measured.
The lesson is not "check sender domains"; it is that a value asserted from
plausibility and a value read from data are different kinds of thing, and this
document should not contain the first kind.
