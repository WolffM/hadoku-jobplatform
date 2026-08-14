# worker/src/routes/jobs.ts

Single-lane finding (below the corroboration gate — one signal, weigh accordingly) · firing: size · 5 lanes applicable · anchor `de063d0fa4b8`

### size — 837 code lines (tier 1)

Largest top-level symbols — the natural cut points:

| symbol | kind | lines | span |
|---|---|---|---|
| `maybeUserId` | async function | 573 | 60–632 |
| `callResumeBinding` | async function | 223 | 806–1028 |
| `gateAuthed` | async function | 157 | 633–789 |
| `bySalaryDesc` | function | 18 | 42–59 |
| `loadTailoringFields` | async function | 10 | 796–805 |

Suggested first cut: extract `maybeUserId` (573 lines) into its own module, with a test first.

### If this finding is wrong or accepted

```
vibecheck wontfix|noise|justify "size:worker/src/routes/jobs.ts" --reason "..."
```
