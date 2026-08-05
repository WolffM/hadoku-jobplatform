# Incident: auto-update blocked by tightened check-usage gate — 2026-08-03/04 failures

> Written 2026-08-05 by an outside investigation run from `hadoku_site`, working
> only from GitHub Actions logs and commit history — it never ran anything in
> this checkout. Treat every claim below as a **hypothesis to verify against
> this repo's own evidence** before acting on it. Verify first, then fix.
>
> **Status 2026-08-05: verified and closed.** In-repo verification confirmed
> the hypothesis for all 11 runs — see "Verification" and "Resolution" below.

## What the daily CI digest showed

`hadoku-jobplatform / Auto-update @wolffm packages` — **3 failures** in the
24h window, latest run green. The full failure streak is longer: **11 failed
runs** from 2026-08-03 23:34 to 2026-08-04 18:30 UTC.

## Evidence gathered from outside

- The last failed run (30938894553, Aug 4 18:30) died in the lint gate:
  `@wolffm/themes` `check-usage.mjs` reported **14 problems** in
  `src/styles/index.css`, all the (then-new) rule _"Fill colour used as bare
  text on a page/card surface"_ (`--color-primary`, `--color-danger`,
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

## Verification (2026-08-05, run from this repo)

- **All 11 failed runs died on the identical check.** Pulled `--log-failed`
  for every run in the streak (30862709845 through 30938894553, Aug 3 23:34 →
  Aug 4 18:30 UTC). Each one shows the same signature: `stylelint` passes,
  then `check-usage: FAILED — 14 problem(s)`, all _"Fill colour used as bare
  text on a page/card surface"_, exit code 1. No other failure cause anywhere
  in the streak. (Run 30869521167 also hit a transient npm `ETIMEDOUT` that
  retried successfully — not a cause.)
- **One correction to the outside hypothesis**: the workflow has no explicit
  lint step. The gate fired from the **husky pre-commit hook**
  (`.husky/pre-commit` runs `pnpm run lint:css`) during the workflow's
  "Commit and push if changed" step — `worker/package.json`'s `prepare`
  script sets `core.hooksPath .husky` during install, so the hook is live in
  CI. That's why a _dependency update commit_ was blocked by a CSS check: the
  freshly-installed `@wolffm/themes` supplied the tightened `check-usage.mjs`,
  and the hook ran it against pre-existing violations.
- **`pnpm run lint:css` is clean on current main** (verified at `bcda7c8`):
  `check-usage: OK — every token reference resolves (41 tokens known).`

## Resolution

- **Policy decision — auto-update stays fail-closed.** When an upstream gate
  tightens, updates stay frozen until this repo complies. Rationale:
  always-latest is already the stated policy (`bcda7c8` makes "not at latest"
  a hard failure), the update commit pushes straight to main and triggers a
  publish, so landing a non-compliant update on a side branch would just move
  an unmissable red cron to an easily-missed unattended PR. The actual defect
  was the _silence_, not the freeze.
- **Fix — a red run now files a GitHub issue within minutes**
  (`update-wolffm.yml`: "Open/refresh alert issue on failure"). Repeat
  failures comment on the same issue; the first green run closes it. This
  keeps the ~19h blind window from recurring without paging for a child-app
  linter — consistent with monitoring-api's split (ci-check pages only for
  service-down workflows; child-app CI red belongs in the digest, and now
  also in an emailed issue).
