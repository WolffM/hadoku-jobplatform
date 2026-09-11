# vibeCompact — agent briefing

Anchor: `5dfb0f7c849d` (2026-09-10). Generated with the audit report; findings below are corroborated by ≥2 independent lanes unless marked otherwise.

## Ground rules

- Fixes need no ceremony: land a commit touching a flagged file and the next audit stamps it `fixed` automatically. Partial progress shows as **improving**.
- Findings you judge wrong get verdicts, not workarounds — the commands are attached to each finding. Verdicts are maintainer decisions; confirm with the human before filing one.
- Do not delete anything without verifying reachability yourself first: string references, dynamic imports, runner and workflow configs.

## Corroborated work items (execution order: smallest blast radius first)

### 1. `src/components/PacketsList.tsx`

- Firing: arrival + smells (6 lanes applicable)
- arrival: add at least one test whose import path reaches this file before changing it further
- smells: replace any-typed identifiers with concrete types
- **Evidence package** (exact symbols, ranges, verification): `.vibecompact/findings/src__components__PacketsList.tsx.md`
- If wrong or accepted: `vibecheck wontfix|noise|justify "arrival:src/components/PacketsList.tsx" --reason "..."`

### 2. `src/components/JobsList.tsx`

- Firing: arrival + smells (6 lanes applicable)
- arrival: add at least one test whose import path reaches this file before changing it further
- smells: replace any-typed identifiers with concrete types
- **Evidence package** (exact symbols, ranges, verification): `.vibecompact/findings/src__components__JobsList.tsx.md`
- If wrong or accepted: `vibecheck wontfix|noise|justify "arrival:src/components/JobsList.tsx" --reason "..."`

### 3. `src/components/UnansweredQuestions.tsx`

- Firing: arrival + smells (6 lanes applicable)
- arrival: add at least one test whose import path reaches this file before changing it further
- smells: replace any-typed identifiers with concrete types
- **Evidence package** (exact symbols, ranges, verification): `.vibecompact/findings/src__components__UnansweredQuestions.tsx.md`
- If wrong or accepted: `vibecheck wontfix|noise|justify "arrival:src/components/UnansweredQuestions.tsx" --reason "..."`

### 4. `src/components/CompaniesManager.tsx`

- Firing: arrival + smells (6 lanes applicable)
- arrival: add at least one test whose import path reaches this file before changing it further
- smells: replace any-typed identifiers with concrete types
- **Evidence package** (exact symbols, ranges, verification): `.vibecompact/findings/src__components__CompaniesManager.tsx.md`
- If wrong or accepted: `vibecheck wontfix|noise|justify "arrival:src/components/CompaniesManager.tsx" --reason "..."`

### 5. `src/components/ProfileEditorModal.tsx`

- Firing: arrival + smells (6 lanes applicable)
- arrival: add at least one test whose import path reaches this file before changing it further
- smells: replace any-typed identifiers with concrete types
- **Evidence package** (exact symbols, ranges, verification): `.vibecompact/findings/src__components__ProfileEditorModal.tsx.md`
- If wrong or accepted: `vibecheck wontfix|noise|justify "arrival:src/components/ProfileEditorModal.tsx" --reason "..."`

## Single-lane findings (one signal each — weigh accordingly)

Each has a full evidence package in `.vibecompact/findings/`.

- `src/components/JobDrawer.tsx` — arrival → `.vibecompact/findings/src__components__JobDrawer.tsx.md`
- `src/components/JobCard.tsx` — arrival → `.vibecompact/findings/src__components__JobCard.tsx.md`
- `worker/tests/routes/applications.test.ts` — size: 614 code lines (tier 1) → `.vibecompact/findings/worker__tests__routes__applications.test.ts.md`
- `src/components/ProfileSidebar.tsx` — arrival → `.vibecompact/findings/src__components__ProfileSidebar.tsx.md`
- `worker/src/routes/companies.ts` — arrival → `.vibecompact/findings/worker__src__routes__companies.ts.md`
- `worker/src/routes/ingest.ts` — size: 561 code lines (tier 1) · precedent: 1 sibling verdict (see package) → `.vibecompact/findings/worker__src__routes__ingest.ts.md`
- `src/App.tsx` — arrival → `.vibecompact/findings/src__App.tsx.md`
- `src/api/applyQueue.ts` — arrival → `.vibecompact/findings/src__api__applyQueue.ts.md`
- `src/components/ApplicationsList.tsx` — arrival → `.vibecompact/findings/src__components__ApplicationsList.tsx.md`
- `src/api/jobs.ts` — arrival → `.vibecompact/findings/src__api__jobs.ts.md`
- `worker/src/routes/profiles.ts` — size: 540 code lines (tier 1) · precedent: 1 sibling verdict (see package) → `.vibecompact/findings/worker__src__routes__profiles.ts.md`
- `worker/tests/routes/jobsFeed.test.ts` — size: 538 code lines (tier 1) → `.vibecompact/findings/worker__tests__routes__jobsFeed.test.ts.md`
- `src/api/profiles.ts` — arrival → `.vibecompact/findings/src__api__profiles.ts.md`
- `worker/src/routes/jobs/feed.ts` — size: 537 code lines (tier 1) → `.vibecompact/findings/worker__src__routes__jobs__feed.ts.md`
- `src/api/companies.ts` — arrival → `.vibecompact/findings/src__api__companies.ts.md`
- `src/api/resource.ts` — arrival → `.vibecompact/findings/src__api__resource.ts.md`
- `worker/src/routes/health.ts` — arrival → `.vibecompact/findings/worker__src__routes__health.ts.md`
- `worker/src/defaultProfile.ts` — arrival → `.vibecompact/findings/worker__src__defaultProfile.ts.md`
- `src/entry.tsx` — arrival → `.vibecompact/findings/src__entry.tsx.md`

## Machine data

Full lane entries, clone partners, scores, and ledger state: `.vibecompact/audit.json` on the data branch, `.vibecompact/out/audit.json` in a local run.
