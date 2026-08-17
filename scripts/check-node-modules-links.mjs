#!/usr/bin/env node
/**
 * Fail loudly when an install directory is full of dangling symlinks.
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * `worker/` is a nested pnpm install. Running its install from inside a
 * `.claude/worktrees/*` checkout links its dependencies into THAT worktree's
 * store. Delete the worktree and the main checkout is left with:
 *
 *   worker/node_modules/@cloudflare/workers-types
 *     -> ../../../.claude/worktrees/<gone>/node_modules/.pnpm/...
 *
 * All of worker/'s dependencies dangle at once. `@cloudflare/workers-types`
 * stops resolving, `worker/tsconfig.json` lists it under `types`, so every
 * Workers global becomes an error type and `recommended-type-checked` fires
 * `no-unsafe-*` on every use site. That surfaced once as 2092 lint errors
 * across files nobody had touched, and blocked every commit in the repo. The
 * symptom looks nothing like the cause, which is the whole reason for this
 * check: the cost of diagnosing it from scratch is hours, and the cost of
 * detecting it is one readdir.
 *
 * CI never sees it — a fresh checkout has no worktrees — so this only ever
 * fires locally, which is exactly where it is expensive.
 *
 * WHY `pnpm install` IS NOT THE REMEDY
 * ------------------------------------
 * pnpm decides the install is already satisfied and short-circuits, leaving
 * every link dangling. Only removing the directory forces the relink, so that
 * is what this prints.
 *
 * Exit 0 = clean (or nothing installed yet). Exit 1 = dangling links found.
 */
import { readdirSync, statSync, lstatSync, readlinkSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Install roots to sweep, in the order a human would suspect them. */
const TARGETS = [
  { dir: 'worker/node_modules', remedy: 'rm -rf worker/node_modules && pnpm install' },
  { dir: 'node_modules', remedy: 'rm -rf node_modules && pnpm install' }
]

/**
 * Top-level package links inside a node_modules directory: `pkg` and
 * `@scope/pkg`, and nothing deeper. Depth 2 is not an optimisation — it is the
 * correct depth. Everything below it lives in `.pnpm`, whose internal links are
 * pnpm's business, and walking into them turns a fast check into a slow one.
 */
function packageLinks(nodeModules) {
  const out = []
  let entries
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    // `.pnpm`, `.bin` and friends are pnpm's own bookkeeping.
    if (entry.name.startsWith('.')) continue
    const path = join(nodeModules, entry.name)
    if (entry.isSymbolicLink()) {
      out.push(path)
      continue
    }
    // A scope directory is real; the links are the packages inside it.
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = readdirSync(path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const inner of scoped) {
        if (inner.isSymbolicLink()) out.push(join(path, inner.name))
      }
    }
  }
  return out
}

/** A link is dangling when its target does not resolve. */
function isDangling(linkPath) {
  try {
    // statSync follows the link; it throws when the target is gone.
    statSync(linkPath)
    return false
  } catch {
    // Confirm it really is a link before blaming it — a genuine read error on a
    // regular file is a different problem and should not be reported as this one.
    try {
      return lstatSync(linkPath).isSymbolicLink()
    } catch {
      return false
    }
  }
}

let failed = false

for (const { dir, remedy } of TARGETS) {
  const abs = join(REPO_ROOT, dir)
  if (!existsSync(abs)) continue

  const links = packageLinks(abs)
  const dangling = links.filter(isDangling)
  if (dangling.length === 0) continue

  failed = true
  const total = links.length
  console.error(`\n✖ ${dir}: ${dangling.length} of ${total} package links are dangling.\n`)

  for (const link of dangling.slice(0, 5)) {
    let target = '(unreadable)'
    try {
      target = readlinkSync(link)
    } catch {
      /* keep the placeholder — the point is the link, not the target */
    }
    console.error(`    ${link.slice(REPO_ROOT.length + 1)}`)
    console.error(`      -> ${target}`)
  }
  if (dangling.length > 5) {
    console.error(`    …and ${dangling.length - 5} more.`)
  }

  console.error(
    '\n  Almost always: this package was installed from inside a\n' +
      '  .claude/worktrees/* checkout, and that worktree has since been removed.\n'
  )
  console.error('  Fix it with:\n')
  console.error(`      ${remedy}\n`)
  console.error(
    '  `pnpm install` on its own will NOT fix this — pnpm sees the install as\n' +
      '  already satisfied and short-circuits, leaving every link dangling.\n'
  )
  console.error(
    '  Left alone this does not look like a dependency problem:\n' +
      '  @cloudflare/workers-types stops resolving, every Workers global becomes\n' +
      '  an error type, and eslint reports thousands of no-unsafe-* errors in\n' +
      '  files you never touched.\n'
  )
}

if (failed) process.exit(1)

console.log('node_modules links: OK — no dangling package links.')
