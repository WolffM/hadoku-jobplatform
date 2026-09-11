# src/components/JobDrawer.tsx

Single-lane finding (below the corroboration gate — one signal, weigh accordingly) · firing: arrival + size · 6 lanes applicable · anchor `5dfb0f7c849d`

### arrival — 100% of 23 commits arrived with no reaching test; largest single-commit arrival 7× the repo median

Before further changes: add one test whose static import path reaches this file.

### size — 537 code lines (tier 1)

Largest top-level symbols — the natural cut points:

| symbol | kind | lines | span |
|---|---|---|---|
| `Props` | interface | 11 | 23–33 |
| `CopyBlock` | function | 11 | 76–86 |

Suggested first cut: extract `Props` (11 lines) into its own module, with a test first.

### If this finding is wrong or accepted

```
vibecheck wontfix|noise|justify "arrival:src/components/JobDrawer.tsx" --reason "..."
vibecheck wontfix|noise|justify "size:src/components/JobDrawer.tsx" --reason "..."
```
