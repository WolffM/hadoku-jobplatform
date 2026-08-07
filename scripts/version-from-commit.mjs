#!/usr/bin/env node
// Conventional-commit version leveling. Run from .husky/post-commit.
//
// WHY POST-COMMIT, AND NOT ANY EARLIER HOOK
// -----------------------------------------
// git snapshots the index immediately after `pre-commit` returns. `pre-commit`
// is therefore the only hook whose staging lands in the commit it runs on — and
// it is the one hook that cannot see the commit message, because git has not
// obtained it yet. `prepare-commit-msg` and `commit-msg` both see the message
// but run after the snapshot, so anything they stage lands in the NEXT commit.
// (Verified on git 2.47.3; it is an easy thing to get wrong.)
//
// So the message can only reach the version by rewriting the commit after the
// fact. That is what this does.
//
// WHAT IT DOES
// ------------
// pre-commit has already decided WHICH packages this commit should bump and
// written a patch/auto bump into each. This script re-reads the message, works
// out the intended LEVEL, and — for those same packages only — recomputes the
// version from the parent commit's value, then amends.
//
// It deliberately does not know anything about a repo's package layout or its
// gating rules. It corrects the level of whatever pre-commit already chose to
// bump, so it drops into a single-package repo and a three-package monorepo
// unchanged.
//
//   feat!: / <type>!: / BREAKING CHANGE: footer  ->  major
//   feat:                                        ->  minor
//   anything else                                ->  left exactly as pre-commit wrote it
//
// Only ever ESCALATES. A `fix:` or `chore:` keeps the repo's existing auto-bump
// behaviour, including the .20 -> next-minor rollover convention, untouched.
//
// IDEMPOTENT: the new version is always computed from the PARENT commit's
// version, never from the working tree, so re-running (or `git commit --amend`)
// converges on the same number instead of climbing.
//
// Escape hatch: BUMP=major|minor|patch|none overrides the message.
// BUMP=none leaves everything alone.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** git that returns null instead of throwing, and never writes to stderr. */
function gitQuiet(...args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** The bump level a conventional-commit message asks for, or null for "leave it". */
export function levelFromMessage(message) {
  const [subject, ...rest] = message.split('\n')
  const body = rest.join('\n')

  // A `!` before the colon, e.g. `feat!:` or `refactor(api)!:`.
  if (/^[a-z]+(\([^)]*\))?!:/i.test(subject.trim())) return 'major'
  // The footer form. Must start a line to avoid matching prose that merely
  // mentions the phrase.
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return 'major'
  if (/^feat(\([^)]*\))?:/i.test(subject.trim())) return 'minor'
  return null
}

export function applyLevel(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return null
  const [major, minor, patch] = m.slice(1).map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`
  return null
}

function readVersionAt(ref, path) {
  const raw = gitQuiet('show', `${ref}:${path}`)
  if (raw === null) return null
  try {
    return JSON.parse(raw).version ?? null
  } catch {
    return null
  }
}

function main() {
  const envBump = (process.env.BUMP ?? '').toLowerCase()
  if (envBump === 'none') return

  // Never rewrite a commit that isn't a plain, just-made commit of our own.
  if (gitQuiet('rev-parse', '--verify', 'HEAD^') === null) return // root commit
  if (gitQuiet('rev-parse', '--verify', 'HEAD^2') !== null) return // merge commit

  // Mid-rebase / mid-cherry-pick / mid-merge / mid-revert: the sequencer owns
  // HEAD, and amending underneath it corrupts the operation. These marker paths
  // exist only while such an operation is in flight.
  const gitDir = git('rev-parse', '--absolute-git-dir')
  const inFlight = [
    'rebase-merge',
    'rebase-apply',
    'CHERRY_PICK_HEAD',
    'MERGE_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'sequencer',
  ]
  if (inFlight.some((marker) => existsSync(`${gitDir}/${marker}`))) return

  const message = git('log', '-1', '--pretty=%B')
  const level = ['major', 'minor', 'patch'].includes(envBump)
    ? envBump
    : levelFromMessage(message)
  if (!level) return // fix:/chore:/docs: — pre-commit's auto bump already stands

  // Only the package.json files THIS commit actually changed, so we inherit
  // whatever gating the repo's pre-commit applied.
  const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')
    .split('\n')
    .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
    .filter((p) => !p.includes('node_modules/'))

  const rewritten = []
  for (const path of changed) {
    const parentVersion = readVersionAt('HEAD^', path)
    const committedVersion = readVersionAt('HEAD', path)
    // A brand-new package.json has no parent version to lever off, and an
    // unchanged version means pre-commit deliberately skipped this package.
    if (!parentVersion || !committedVersion || parentVersion === committedVersion) continue

    const target = applyLevel(parentVersion, level)
    if (!target || target === committedVersion) continue

    const src = readFileSync(path, 'utf8')
    const patched = src.replace(/("version"\s*:\s*")[^"]*(")/, (mm, a, b) => a + target + b)
    if (patched === src) throw new Error(`no version field in ${path}`)
    writeFileSync(path, patched)
    git('add', path)
    rewritten.push(`${path}: ${committedVersion} -> ${target}`)
  }

  if (!rewritten.length) return

  // --no-verify so the amend doesn't re-run pre-commit (which would bump a
  // second time, and re-run the whole lint/typecheck gate for a one-field
  // edit). SKIP_VERSION_LEVEL stops the amend's own post-commit re-entering
  // this script.
  try {
    execFileSync('git', ['commit', '--amend', '--no-edit', '--no-verify'], {
      stdio: 'ignore',
      env: { ...process.env, HUSKY: '0', SKIP_VERSION_LEVEL: '1' },
    })
  } catch {
    // The bumped files are staged but the commit was not rewritten. Say so
    // loudly rather than leaving a silently dirty tree — `git commit --amend
    // --no-edit --no-verify` finishes the job by hand.
    console.error('⚠️  version leveling staged these but could NOT amend the commit:')
    for (const line of rewritten) console.error(`   ${line}`)
    console.error('   finish with: git commit --amend --no-edit --no-verify')
    return
  }

  console.log(`🔖 ${level} (from commit message)`)
  for (const line of rewritten) console.log(`   ${line}`)
}

// Guard against the amend above re-entering this script.
if (process.env.SKIP_VERSION_LEVEL !== '1') main()
