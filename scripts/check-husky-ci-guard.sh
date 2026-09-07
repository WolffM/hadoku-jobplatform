#!/bin/sh
# The pre-commit hook must stand down in CI.
#
# It did not, and that broke the @wolffm auto-update workflow: its "Commit and
# push if changed" step fired the hook, whose typecheck triggers a `pnpm
# install` with no NODE_AUTH_TOKEN in that step, so the commit died on
# ERR_PNPM_FETCH_401 fetching a private package — a dependency bump failing on
# the registry auth of a gate CI had already run as its own job.
#
# That failure only appears when the workflow actually has something to commit,
# which is rare enough that watching for it is not verification. This runs the
# real hook under CI conditions on every CI run instead.
set -e

hook=.husky/pre-commit
fails=0

ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }

[ -f "$hook" ] || { echo "no $hook — run from the repo root"; exit 1; }

# ── 1. CI=true: exit 0, say why, and run none of the gates ──────────────────
if out=$(CI=true sh "$hook" 2>&1); then
  case "$out" in
    *"CI detected"*) ok "CI=true stands down, and says so" ;;
    *) bad "CI=true exited 0 but printed no reason: $out" ;;
  esac
  case "$out" in
    *"Running pre-commit checks"*|*"Running typecheck"*|*"version bumped"*)
      bad "CI=true still ran the gates — the guard is too late in the file" ;;
    *) ok "CI=true ran no gate" ;;
  esac
else
  bad "CI=true exited non-zero — this is exactly what breaks a CI commit"
fi

# ── 2. GITHUB_ACTIONS alone is enough ───────────────────────────────────────
# A workflow step can run without CI set; Actions always sets this one.
if out=$(env -u CI GITHUB_ACTIONS=true sh "$hook" 2>&1); then
  case "$out" in
    *"CI detected"*) ok "GITHUB_ACTIONS=true alone stands down" ;;
    *) bad "GITHUB_ACTIONS=true did not stand down" ;;
  esac
else
  bad "GITHUB_ACTIONS=true exited non-zero"
fi

# ── 3. The guard must be CONDITIONAL ────────────────────────────────────────
# Running the hook for real outside CI would bump versions and rewrite the
# lockfile, so this asserts on the file: the gates are still there to run, and
# standing down is tied to the CI variables rather than unconditional.
if grep -q 'pnpm run typecheck' "$hook"; then
  ok "the gates are still in the hook for developers"
else
  bad "the hook no longer typechecks — the guard was not supposed to remove it"
fi

if grep -qE '\$\{CI-\}|\$\{GITHUB_ACTIONS-\}' "$hook"; then
  ok "standing down is conditional on the CI variables"
else
  bad "no CI condition found — the hook may now skip for everyone"
fi

# ── 4. No backticks inside double quotes ────────────────────────────────────
# `--no-verify` in an error message was command substitution: the hook ran it,
# printed "--no-verify: not found", and rendered its own advice with a hole.
if grep -n '^[^#]*"[^"]*`' "$hook" >/dev/null 2>&1; then
  bad "backticks inside a double-quoted string — that is command substitution:"
  grep -n '^[^#]*"[^"]*`' "$hook" | sed 's/^/       /'
else
  ok "no command substitution hiding in a quoted message"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "husky CI guard: all checks passed"
else
  echo "husky CI guard: $fails check(s) failed"
  exit 1
fi
