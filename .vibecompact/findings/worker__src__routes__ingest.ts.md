# worker/src/routes/ingest.ts

Single-lane finding (below the corroboration gate — one signal, weigh accordingly) · firing: size · 6 lanes applicable · anchor `5dfb0f7c849d`

### size — 561 code lines (tier 1)

Largest top-level symbols — the natural cut points:

| symbol | kind | lines | span |
|---|---|---|---|
| `backfillRolesRoute` | const | 45 | 449–493 |
| `backfillRoute` | const | 41 | 273–313 |
| `backfillSalaryRoute` | const | 32 | 628–659 |
| `directivesRoute` | const | 29 | 556–584 |
| `rankNewJobs` | async function | 26 | 65–90 |
| `rebuildRankRoute` | const | 26 | 373–398 |

Suggested first cut: extract `backfillRolesRoute` (45 lines) into its own module, with a test first.

### Precedent — sibling verdicts in this directory

- `justified` on `size:worker/src/routes/jobs.ts` (2026-08-17): "Cohesive router: six endpoints for one resource sharing maybeUserId, gateAuthed and callResumeBinding, plus inline zod-openapi schemas that inflate the line count without adding branching. Splitting it needs characterization tests first (this skill's own rule) and the lane's suggested cut point is unusable — its symbol map reports impossible spans (callResumeBinding at 807-1029 in a then-970-line file; maybeUserId as 574 lines when it is ~11), because it measures distance to the next function keyword and swallows the intervening app.openapi route registrations. Reported separately as a detector bug. Not splitting a live app's only jobs router on a broken cut suggestion; the 180-day expiry and the >20% hard-reopen are the right leash."

If this finding matches the same pattern, propose the same verdict instead of re-investigating.

### If this finding is wrong or accepted

```
vibecheck wontfix|noise|justify "size:worker/src/routes/ingest.ts" --reason "..."
```
