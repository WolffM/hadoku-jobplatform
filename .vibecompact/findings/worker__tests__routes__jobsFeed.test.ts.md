# worker/tests/routes/jobsFeed.test.ts

Single-lane finding (below the corroboration gate — one signal, weigh accordingly) · firing: size · 4 lanes applicable · anchor `5dfb0f7c849d`

### size — 538 code lines (tier 1)

Largest top-level symbols — the natural cut points:

| symbol | kind | lines | span |
|---|---|---|---|
| `FeedBody` | interface | 19 | 14–32 |

Suggested first cut: extract `FeedBody` (19 lines) into its own module, with a test first.

### If this finding is wrong or accepted

```
vibecheck wontfix|noise|justify "size:worker/tests/routes/jobsFeed.test.ts" --reason "..."
```
