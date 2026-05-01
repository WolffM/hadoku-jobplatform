#!/usr/bin/env node
/**
 * Kill anything listening on the given port. Used as a pretest hook so a
 * stale or unresponsive dev server doesn't make playwright's webServer
 * start fail with EADDRINUSE.
 *
 * Targets PIDs found via `lsof -ti:<port>` — won't accidentally match
 * unrelated processes whose argv contains "vite" or similar.
 *
 * No-op when nothing is on the port.
 */

import { execSync } from 'node:child_process'

const port = process.argv[2] ?? '5173'

let pids = []
try {
  const out = execSync(`lsof -ti:${port}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  pids = out
    .trim()
    .split('\n')
    .filter(Boolean)
} catch {
  // lsof exits non-zero when nothing matches — port is already free.
  process.exit(0)
}

if (pids.length === 0) {
  process.exit(0)
}

for (const pid of pids) {
  try {
    execSync(`kill ${pid}`)
    console.log(`[free-port] killed pid ${pid} on :${port}`)
  } catch (err) {
    console.warn(`[free-port] failed to kill pid ${pid}:`, (err && err.message) || err)
  }
}

// Give the OS a moment to release the socket so the next `listen()` doesn't
// race with the dying process.
execSync('sleep 0.5')
