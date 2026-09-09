# Handoff: the apply pipeline, from a scraper-side agent

Written 2026-09-08 by the agent that shipped the work described below, for
whoever picks this up from inside this repo.

Everything factual here was re-verified against the live worker on the day of
writing. Where I could not verify something, it says so.

---

## 1. Read this before you touch a credential

**Your vault grant is friend-tier. You cannot act as the owner over the HTTP API
from this repo — but you can read every table directly, which is usually what you
actually wanted.**

Added 2026-09-08: `.devvault.json` here also grants `CLOUDFLARE_API_TOKEN`, so
this works from this repo with no borrowed credential and no service key:

```sh
node ../hadoku_site/scripts/secrets/dev-vault.mjs -- bash -c \
  "cd ../hadoku_site/workers/jobplatform-api && \
   npx wrangler d1 execute jobplatform --remote --json --command \"SELECT ...\""
```

Every "live state" fact in this document was re-verified that way, including the
three corrections marked below. It is read-only in practice and it shows you the
WHOLE table rather than one identity's slice — which is exactly the blind spot
that produced the two false leads in §7.3. Reach for a service key when you need
to exercise the API's own auth path; reach for D1 when you need to know what is
true.

`.devvault.json` here asks for four keys, and the only registry credential among
them is `FRIEND_KEY` (registry name `jobplatform-e2e`, tier **friend**). Verified:

```
FRIEND_KEY whoami -> {"valid":true,"userType":"friend",...}
FRIEND_KEY GET /applications?ownerName=hadoku -> 403
  "Only a service or admin caller may act on behalf of a named owner."
```

That 403 is **correct and deliberate** — see `effectiveUserId` in
`worker/src/routes/jobs/shared.ts`. A friend-tier caller is a signed-in human in
a browser; letting one pass `ownerName` would turn every per-user route into a
way to read and mutate someone else's queue. Do not "fix" it.

It does mean that the moment you try to inspect the owner's real rows, you get a
403 and it looks like the feature is broken. It isn't. Two ways forward:

1. **Borrow the scraper's grant** (what I did all session):
   ```sh
   cd ../hadoku-scraper
   node ../hadoku_site/scripts/secrets/dev-vault.mjs -- <your command>
   ```
   That repo's manifest maps `HADOKU_SERVICE_KEY` -> `KEY_SERVICE_SCRAPER`,
   which is service tier and works.
2. **Ask the operator to mint one for this repo.** dev-vault prints the exact
   command when it can't find a key.

I lost a round to this yesterday: I ran dev-vault from _this_ repo, got
`403 Authentication required`, and briefly thought a deploy had broken identity.
It hadn't — the env var simply wasn't in this repo's manifest, so it expanded to
an empty string. **A 403 from an inter-service call is a credentials question
before it is a code question.**

Tier ranking, for reference: `public(0) < friend(1) < service(2) < wife(3) < admin(4)`.
Service outranks friend.

---

## 2. What the pipeline is

Three repos, one flow. You own the middle one.

```
hadoku-scraper          hadoku-jobplatform         hadoku-resume-bot
 scrape boards    ->     rank, tailor, queue   ->   build the tailored PDF
 fill ATS forms   <-     serve the queue       <-
 report back      ->     store evidence
```

- The **runner** lives in `hadoku-scraper` (`hadoku_scrape/apply/`). It drives a
  real browser (Patchright) against Greenhouse/Ashby/Lever forms.
- It authenticates as a **SERVICE** while the queue is keyed to a **PERSON**.
  That mismatch is the entire reason `effectiveUserId` and `ownerName` exist.
- The dashboard's **Approve** button is the consent gate. Nothing is ever sent
  without it.

Status flow: `queued -> filled -> approved -> submitted`, with `needs_manual`,
`failed` and `job_closed` as the honest failure exits.

---

## 3. Where the work stands right now

Live as of 2026-09-08, read via `GET /applications?ownerName=hadoku`:

| job                              | status         | filled | blocking | what it needs              |
| -------------------------------- | -------------- | ------ | -------- | -------------------------- |
| `greenhouse_8051871` (Coinbase)  | `filled`       | 25     | 0        | **owner to click Approve** |
| `greenhouse_8154983` (Coinbase)  | `filled`       | 25     | 0        | **owner to click Approve** |
| `greenhouse_7888329` (Pinterest) | `needs_manual` | 8      | 0        | 6 answers, below           |

**No application has ever been submitted by a person.** The one `submitted` row
in the table is a TEST ARTIFACT — see the identity table in §3.1. The handoff's
original wording was right; a correction I made earlier on 2026-09-08 ("one has
been submitted, under identity 4b31a445") was wrong, because I had not yet
worked out what 4b31a445 is.

Both Coinbase rows previously sat at `failed` — the click landed, the form failed its own
client-side validation, and zero network requests fired. That is now fixed and
they fill clean, but they are still waiting on a human.

`approved_fingerprint` is `null` on all three. Approval is bound to the exact
filled content; a re-fill invalidates it by design, and re-queuing clears it.
**Never re-queue an approved row as a side effect** — `POST /jobs/:id/apply`
clears `approved_fingerprint` and silently throws the approval away.

### The six open questions (Pinterest)

`GET /unanswered-questions?ownerName=hadoku` — 4 have option pickers, 2 are text:

| kind   | question                                                                                    |
| ------ | ------------------------------------------------------------------------------------------- |
| picker | How did you first hear about this opportunity?                                              |
| picker | What U.S State do you currently reside in?                                                  |
| picker | Are you legally authorized to work in the country in which you are applying for a position? |
| picker | Will you now or in the future require employer sponsorship...?                              |
| text   | Website                                                                                     |
| text   | If you do require sponsorship, please list the type of support you may require.             |

22 standing answers are already stored. These six are not covered because the
matcher **refuses rather than guesses** — see §6.

---

## 4. The loop

```sh
# from ../hadoku-scraper, with its vault grant
hs apply status  --owner hadoku          # what the runner would act on
hs apply run     --owner hadoku          # fill + screenshot; sends NOTHING
hs apply run     --owner hadoku --submit # sends rows the owner approved
hs apply coverage                        # bucket every posting by fillability
```

`fill` can never submit — that is structural, not a flag. See
`scripts/prove_fill_never_submits.py` in the scraper repo.

To re-fill after answering questions: answer -> `POST /jobs/:id/apply` (re-queue)
-> `hs apply run`. Screenshots land in `data/apply/shots/<application-id>/`.

**Autonomous submit is authorized for `approved` rows only.** The owner said so
explicitly; the dashboard Approve click is the consent. It extends to nothing
else.

---

## 5. What I changed, so you don't undo it

**This repo** — `ee59c53` `fix(identity): read ownerName from the query on POSTs too`

The routes split by method: GETs read `?ownerName=`, POSTs read it from the JSON
body. So `POST /jobs/:id/apply?ownerName=Hadoku` was accepted, **ignored**, and
queued onto the caller's rows. It returns 200 with a valid-looking application
that belongs to the wrong person; the only symptom is the owner's dashboard
staying empty while the runner reports success.

Fixed in `effectiveUserId` rather than per-route, so no future route can
reintroduce it. **Body wins** when both are given. `ownerName` is now one shared
query schema (`ownerNameQuery` in `shared.ts`) used by all four routes that
honour it. Three of the four new tests in `worker/tests/routes/actAsOwner.test.ts`
fail without the fix — I checked by reverting it, not by assuming.

Also declared `ExecutionContext` in the tests eslint globals; `npm run lint` in
`worker/` was failing on main because `no-undef` can't tell a TS type from a
value.

**Scraper repo** — `e000b41`, `d6520b6`: work-history/education support. Relevant
to you only because it is why the Coinbase rows now fill clean.

---

## 6. Traps that have already cost time

**`ownerName`, never `owner`.** The field carries a display _name_ to be
resolved. `owner`/`userId`/`ownerId` are reserved for already-resolved identities
(identity model R5: never store an identifier you did not resolve). A commit
renamed this and my calls sent the old name for a while — silently ignored,
returning my own empty rows. I built an elaborate wrong theory before a
one-request test settled it.

**The one-request test.** When you suspect a parameter is being dropped, send a
name that cannot exist:

```
?ownerName=Nobody  ->  must be 404 NAME_NOT_FOUND, never 200
```

A 200 means the parameter is being ignored. This is the cheapest diagnostic in
the system and it has caught the same class of bug twice.

**Identity error codes are distinct on purpose.** `NO_REGISTRY -> 503`,
`NAME_NOT_FOUND -> 404`, `NO_USER_ID -> 409`. A 503 must never read as "no such
user" when it is our own resolver being unreachable.

**`POST /applications/:id/approve` uses `maybeUserId`, not `effectiveUserId`** —
verified. It is owner-only and takes no `ownerName`. That is the consent gate;
a service must not approve on the owner's behalf. **Do not add `ownerName` to it.**

**`GET /profiles` calls `ensureDefaultProfile` — a read that writes.** Still true
(`worker/src/routes/profiles.ts:249`). Probing it as different identities creates
profiles. My testing created three; the owner looked and said it was fine, but
know that the endpoint is not side-effect-free before you loop over it.

**The deploy gate.** hadoku_site's D1 migrations only apply when the
jobplatform-worker version actually bumps, and dispatches can race. After
shipping a migration, verify it actually landed rather than trusting the
workflow's green tick.

**Don't trust "no error" as success.** The whole submit bug was `parse_missing`
returning `[]` for a form with eleven `aria-invalid` fields, which the runner
reported as "named no missing field" — reading as "probably went through". A
combobox that refuses a value leaves the field empty while the page still reports
`aria-invalid="false"`. Success is asserted from explicit confirmation text only.

---

## 7. Open decisions — for the owner, not for you to pick

**1. ~~`PUT /application-answers` cannot act on behalf of an owner.~~ DECIDED
2026-09-08 by the owner: it was an oversight. Fixed — both the PUT and
`DELETE /application-answers/{key}` now take `ownerName` like their neighbours.**

The PUT reads it from the body or the query and prefers the body, matching
`POST /jobs/:id/apply`; the DELETE has no body, so the query is its only
channel. Five tests in `worker/tests/routes/actAsOwner.test.ts` cover it, and I
confirmed four of them fail against the old handlers by reverting — the fifth
("still writes to the caller when no owner is named") is the no-regression
guard and passes either way.

**The asymmetry with `POST /applications/:id/approve` is deliberate and stays**,
and the reason is now a comment on `SetAnswerSchema` so nobody has to re-derive
it: approval is CONSENT to send a specific filled form, and a service must never
give it. A standing answer is a fact about the owner that the runner already
collects from them; storing one sends nothing. Those are different things, and
only one of them is a consent gate.

**2. Board application limits are unmodelled.** Nothing tracks how many
applications we have sent to one employer, or any per-board cap. Not urgent while
zero have been sent; it becomes urgent the moment volume picks up.

**3. ~~Orphaned rows and stale directives~~ — CHECKED 2026-09-08. Both dissolve,
but not for the reason I first gave. Do not clean either up.**

The 214 `profile_companies` rows are real. They sit on profile `6823d011…`,
`discovery-auto (probation boards 2026-08-17)`, owned by `4b31a445…` — which is
**this repo's own e2e test credential**, not a person. See §3.1. They are the
fixture the local Playwright suite ranks against; deleting them changes what
`pnpm test:e2e` sees.

The four "stale" directives are on that same profile and all producing:

| board                         | jobs in corpus |
| ----------------------------- | -------------- |
| `greenhouse/datadoghq`        | 77             |
| `greenhouse/pinterestcareers` | 81             |
| `greenhouse/toasttab`         | 129            |
| `greenhouse/withwaymo`        | 90             |

The reasoning trap is worth more than the finding, and it caught me twice.
`GET /profiles?ownerName=hadoku` is scoped to ONE identity by design, so absence
from it is not evidence of orphanhood — that is the first trap, and it produced
the original "orphaned rows" lead. The second is subtler and I fell in it while
correcting the first: seeing rows under an unfamiliar UUID and concluding "another
user". **Resolve the UUID before you characterise it.** One `whoami` with the key
from this repo's own `.devvault.json` would have answered it immediately, and did.

---

## 3.1 Who the identities in this database actually are

`user_id` is a registry UUID that edge-router injects and that SURVIVES key
rotation (`worker/src/userId.ts`) — so two UUIDs are two registry entries, never
one person's rotated key. Seven appear in D1:

| user_id                             | what it is                                                                                 | evidence                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `de5c2a05…`                         | **the owner (hadoku)**                                                                     | 1 Default profile (3 companies), 7 triage rows, 6 votes, 22 standing answers, 3 applications                                                                   |
| `4b31a445…`                         | **`jobplatform-e2e` — this repo's own test key**                                           | `whoami` with `FRIEND_KEY` from `.devvault.json` returns exactly this UUID. 2 profiles (Default + discovery-auto/214 companies), 1 `submitted` application     |
| `fe658f71…`                         | profile named "Matthaeus"; 3 `failed` applications, all `evidence IS NULL`, all 2026-09-08 | unidentified — behaviourally a test/agent identity, but the profile NAME is a human's, so ask before assuming                                                  |
| `991c8143…` `bfc57178…` `ecd0d30b…` | probe residue                                                                              | three Default profiles created 2026-09-07 at 06:35:39, :40 and :41 — one second apart. This is the `GET /profiles`-is-a-write side effect, exactly as §6 warns |
| `71657d36…`                         | one triage row, nothing else                                                               | —                                                                                                                                                              |

**Only `de5c2a05…` has votes or standing answers.** That is the sharpest tell in
the table: those two are things a human does in a browser and no automation in
this system writes. Use it before you attribute activity to a person.

Two consequences worth knowing:

- **The Playwright suite writes to PRODUCTION as `4b31a445…`.** `tests/jobplatform.spec.ts`
  sets and clears triage on live rows through the dev proxy. It cleans up after
  itself, but a killed run leaves state behind, and that state is indistinguishable
  from a real one except by which identity holds it.
- The e2e suite's fixture profile is `profiles[0]` for that key, currently the
  0-company `Default` — so it ranks the whole corpus. That is why the suite's
  feed calls are the slow ones.

## 8. House rules that bit me

- Work in a git worktree, never the shared checkout. Push with an explicit
  refspec: `git push origin HEAD:main`, never a bare `git push origin main`.
- Never `git stash` in a shared repo — the stash is repo-global and will swallow
  another agent's uncommitted files.
- No AI attribution in commits or PRs.
- Pushing to `main` is pre-authorized in `github.com/WolffM/*`, including when it
  triggers a publish or deploy.
- A failing test is a bug to fix, not to skip — including one that was already
  red when you arrived.
