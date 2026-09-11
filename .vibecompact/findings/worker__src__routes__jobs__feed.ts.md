# worker/src/routes/jobs/feed.ts

Single-lane finding (below the corroboration gate — one signal, weigh accordingly) · firing: size · 6 lanes applicable · anchor `5dfb0f7c849d`

### size — 537 code lines (tier 1)

Largest top-level symbols — the natural cut points:

| symbol | kind | lines | span |
|---|---|---|---|
| `registerFeedRoute` | function | 574 | 188–761 |
| `applicationsByCompany` | async function | 16 | 122–137 |
| `LightRow` | interface | 15 | 145–159 |
| `HeavyRow` | interface | 12 | 162–173 |

`registerFeedRoute` alone is 75% of the file — moving it to its own module would relocate the problem, not reduce it. Cut inside it instead:

Suggested first cut: split `registerFeedRoute` at its internal boundaries (blocks, route groups, phases) rather than extracting it whole, with a test first.

### If this finding is wrong or accepted

```
vibecheck wontfix|noise|justify "size:worker/src/routes/jobs/feed.ts" --reason "..."
```
