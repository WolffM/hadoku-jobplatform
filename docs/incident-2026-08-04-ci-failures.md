# Incident: auto-update blocked by tightened check-usage gate — 2026-08-03/04 failures

> Written 2026-08-05 by an outside investigation run from `hadoku_site`, working
> only from GitHub Actions logs and commit history — it never ran anything in
> this checkout. Treat every claim below as a **hypothesis to verify against
> this repo's own evidence** before acting on it. Verify first, then fix.

## What the daily CI digest showed

`hadoku-jobplatform / Auto-update @wolffm packages` — **3 failures** in the
24h window, latest run green. The full failure streak is longer: **11 failed
runs** from 2026-08-03 23:34 to 2026-08-04 18:30 UTC.

## Evidence gathered from outside

- The last failed run (30938894553, Aug 4 18:30) died in the lint gate:
  `@wolffm/themes` `check-usage.mjs` reported **14 problems** in
  `src/styles/index.css`, all the (then-new) rule *"Fill colour used as bare
  text on a page/card surface"* (`--color-primary`, `--color-danger`,
  `--color-success`, `--color-warning`, `--color-success-dark` used as text
  colours).
- So the tightened check in a freshly published `@wolffm/themes` blocked this
  repo from taking ANY package updates until the pre-existing CSS violations
  were fixed — the gate worked as designed, but it froze the update pipeline
  for ~19 hours with no alert.
- 2026-08-04 20:59, `34b730ad` — `fix(a11y): stop using fill colours as bare
  text` — fixed the CSS; auto-updates landed green from 21:46 onward
  (`4e70afaf`, `a6c8e4b7`, `130b5a49`).
- **Not verified from outside**: whether the earlier failures in the streak
  (Aug 3 23:34 → Aug 4 12:34) failed on this same check or on something else.
  Only the 18:30 run's log was read.

## Root-cause hypothesis

An upstream strictness increase in `@wolffm/themes`' check-usage landed as a
published package, and this repo's auto-update workflow runs that gate — so
pre-existing violations here turned every update attempt red until a human
noticed and swept the CSS.

## Your task

1. **Verify independently.** Pull the logs of the earlier failed runs
   (30862709845, 30862842315, 30865452766, 30869420412, 30869521167,
   30869728653, 30869853115, 30885330583, 30909711920, 30937446351) and
   confirm they failed on the same check-usage rule — or find and document
   whichever different cause is in there. Confirm `pnpm run lint:css` is clean
   on current main.
2. **Then fix what verification confirms.** Candidates found from outside:
   - **Silent-failure window**: ~19 hours of blocked updates with no alert.
     Decide whether a red auto-update run should report to `/health/api/jobs`
     or open an issue, instead of waiting for the daily digest.
   - **Policy question worth an explicit decision**: when an upstream gate
     tightens, should auto-update fail closed (current behaviour — no updates
     until the repo complies) or land the update on a branch/PR so the
     violation is visible as reviewable work rather than a red cron? Write the
     decision down either way.

If your investigation contradicts anything above, trust your evidence, not
this document — and correct this file so the record is right.
