#!/usr/bin/env node
/**
 * Production verification of the JobPulse merge (steps 1–4), as the e2e
 * account, against hadoku.me. Run through dev-vault so FRIEND_KEY is set:
 *
 *   pnpm exec dev-vault -- node scripts/verify-merge-prod.mjs
 *
 * Imports one posting the corpus does NOT yet hold from each source the import
 * supports, then reads every one back through the API and checks what was
 * stored — and exercises tracking, the timeline, insights, the near filter and
 * blocking on them. Every state it sets is cleared in `finally`; the imported
 * postings stay in the corpus, because they are real, listed jobs.
 *
 * Exits non-zero on the first failed check.
 */
const KEY = process.env.FRIEND_KEY
if (!KEY) throw new Error('FRIEND_KEY is not set — run through dev-vault')
const API = 'https://hadoku.me/jobplatform/api'
const H = { 'X-User-Key': KEY, 'User-Agent': 'Mozilla/5.0 hadoku-agent (verify-merge-prod)' }

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...H, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': H['User-Agent'] } })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** The first candidate whose job id the corpus does not hold yet. */
async function firstNew(candidates) {
  for (const c of candidates) {
    const { status } = await api(`/jobs/${encodeURIComponent(c.id)}`)
    if (status === 404) return c
  }
  return null
}

/** Up to `per` postings from each board, in board order. Unreachable boards are skipped. */
async function fromBoards(boards, list, map, per = 8) {
  const out = []
  for (const b of boards) {
    try {
      out.push(...(await list(b)).slice(0, per).map(map(b)))
    } catch {
      // A board that 404s (renamed, closed) just isn't a candidate.
    }
  }
  return out
}

/**
 * Postings from boards the nightly search is unlikely to subscribe to, so a
 * new-to-the-corpus pick exists. The big boards (figma, spotify, ramp, waymo)
 * were all already fully ingested on 2026-11-08.
 */
async function candidates() {
  const ghList = async b =>
    (await getJSON(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs`)).jobs
  const wwr = await (
    await fetch('https://weworkremotely.com/remote-jobs.rss', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
  ).text()
  return {
    greenhouse: await fromBoards(
      ['gitlab', 'duolingo', 'airtable', 'squarespace', 'dropbox', 'reddit', 'asana', 'webflow'],
      ghList,
      () => j => ({ id: `greenhouse_${j.id}`, url: j.absolute_url })
    ),
    lever: await fromBoards(
      ['plaid', 'kraken', 'zoox', 'attentive', 'mistral', 'whoop', 'palantir', 'spotify'],
      async b => getJSON(`https://api.lever.co/v0/postings/${b}?limit=20`),
      () => j => ({ id: `lever_${j.id}`, url: j.hostedUrl })
    ),
    ashby: await fromBoards(
      ['posthog', 'linear', 'vercel', 'deel', 'replit', 'notion', 'cursor', 'ramp'],
      async b =>
        (await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${b}`)).jobs.filter(
          j => j.isListed !== false
        ),
      () => j => ({ id: `ashby_${j.id}`, url: j.jobUrl })
    ),
    'greenhouse (employer-hosted gh_jid)': (
      await fromBoards(
        [
          'stripe',
          'datadog',
          'pinterest',
          'coinbase',
          'waymo',
          'cloudflare',
          'twilio',
          'robinhood'
        ],
        ghList,
        () => j => ({ id: `greenhouse_${j.id}`, url: j.absolute_url }),
        40
      )
    ).filter(c => c.url.includes('gh_jid=')),
    // JSON-LD ids are a hash of the URL, so "new" is decided by the import's
    // own `created` rather than a detail probe.
    'JSON-LD (weworkremotely)': [
      ...wwr.matchAll(/<link>(https:\/\/weworkremotely\.com\/remote-jobs\/[^<]+)<\/link>/g)
    ]
      .slice(0, 12)
      .map(m => ({ id: null, url: m[1] }))
  }
}

const touched = new Set()

async function main() {
  console.log('Import: one posting new to the corpus from each source')
  const pool = await candidates()
  const imported = []
  for (const [source, list] of Object.entries(pool)) {
    let pick = null
    let res = null
    if (list[0]?.id === null) {
      // No id to probe: import until one is new to the corpus (keyword
      // sources may already hold the newest), clearing each miss.
      for (const c of list.slice(0, 12)) {
        res = await api('/jobs/import', {
          method: 'POST',
          body: JSON.stringify({ url: c.url, state: 'saved' })
        })
        if (res.status === 200) touched.add(res.body.data.job.id)
        else
          console.log(
            `      (skipped ${c.url}: ${res.status} ${res.body?.message ?? ''})`.slice(0, 160)
          )
        if (res.status === 200 && res.body.data.created) {
          pick = c
          break
        }
      }
    } else {
      pick = await firstNew(list)
      if (pick) {
        res = await api('/jobs/import', {
          method: 'POST',
          body: JSON.stringify({ url: pick.url, state: 'saved' })
        })
      }
    }
    if (!pick || !res) {
      check(
        false,
        `${source}: found a posting the corpus does not hold`,
        res ? `last HTTP ${res.status} ${res.body?.message ?? ''}` : ''
      )
      continue
    }
    const d = res.body?.data
    check(
      res.status === 200,
      `${source}: imported`,
      `HTTP ${res.status} ${res.body?.message ?? ''}`
    )
    if (res.status !== 200) continue
    touched.add(d.job.id)
    if (pick.id) check(d.job.id === pick.id, `${source}: stored under the nightly id`, d.job.id)
    check(d.created === true, `${source}: a new corpus row`, `created=${d.created}`)
    check(d.state === 'saved' && !d.already_tracked, `${source}: saved to the pipeline`)
    imported.push({ source, ...d.job })
  }

  console.log('\nWhat was stored, read back through GET /jobs/:id')
  for (const j of imported) {
    const { status, body } = await api(`/jobs/${encodeURIComponent(j.id)}`)
    const job = body?.data?.job
    check(status === 200 && !!job, `${j.source}: detail readable`)
    if (!job) continue
    check(
      job.title.length > 0 && job.company.length > 0,
      `${j.source}: title and company`,
      `${job.company} — ${job.title}`
    )
    check(
      job.description.length > 200,
      `${j.source}: full description`,
      `${job.description.length} chars`
    )
    check(job.state === 'saved', `${j.source}: caller's state`, job.state)
    check(job.tracking !== null, `${j.source}: tracking present on detail`)
    check(
      ['ic', 'manager', 'unknown'].includes(job.role_track),
      `${j.source}: role classified`,
      `${job.role_track}/${job.role_level}`
    )
    if (!j.source.startsWith('JSON-LD')) {
      check(
        !!job.ats && !!job.slug,
        `${j.source}: board known`,
        `${job.ats}:${job.slug} (${job.slug_source})`
      )
    }
    console.log(
      `      location "${job.location}" · ${job.workplace_type} · salary ${job.salary_min ?? '—'}–${job.salary_max ?? '—'}`
    )
  }

  console.log('\nPipeline, timeline and tracking')
  const pipe = await api('/pipeline')
  const ids = new Set(pipe.body.data.items.map(i => i.job_id))
  check(
    imported.every(j => ids.has(j.id)),
    'every import is on GET /pipeline',
    `${imported.length} imported`
  )
  const target = imported[0]
  if (target) {
    const ev = await api(`/jobs/${encodeURIComponent(target.id)}/events`)
    const first = ev.body.data.events[0]
    check(
      first?.kind === 'state' && first.from_state === null && first.to_state === 'saved',
      'timeline starts "added as saved"'
    )
    const moved = await api(`/jobs/${encodeURIComponent(target.id)}/state`, {
      method: 'PUT',
      body: JSON.stringify({ state: 'applied' })
    })
    check(moved.status === 200, 'move to applied')
    const tracked = await api(`/jobs/${encodeURIComponent(target.id)}/tracking`, {
      method: 'PATCH',
      body: JSON.stringify({
        priority: 1,
        follow_up_at: '2026-11-20',
        contact_name: 'Verify Script'
      })
    })
    check(tracked.status === 200 && tracked.body.data.tracking.priority === 1, 'tracking saved')
    const logged = await api(`/jobs/${encodeURIComponent(target.id)}/events`, {
      method: 'POST',
      // Now, so it follows the two transitions: the timeline orders by when
      // things happened, and a bare date is that day's midnight UTC.
      body: JSON.stringify({
        kind: 'interview',
        note: 'verify-merge-prod',
        occurred_at: new Date().toISOString()
      })
    })
    check(logged.status === 201, 'interview logged')
    const after = await api(`/jobs/${encodeURIComponent(target.id)}/events`)
    const kinds = after.body.data.events.map(e =>
      e.kind === 'state' ? `${e.from_state}→${e.to_state}` : e.kind
    )
    check(
      kinds.join(',') === 'null→saved,saved→applied,interview',
      'timeline reads in order',
      kinds.join(', ')
    )

    const insights = await api('/insights')
    check(
      insights.status === 200 && insights.body.data.reached.applied >= 1,
      'insights counts the application',
      `applied=${insights.body.data.reached.applied}`
    )
    check(
      insights.body.data.skill_postings >= imported.length,
      'insights reads the imported postings for skills',
      `${insights.body.data.skill_postings} postings`
    )
  }

  console.log('\nFeed filters over the imports')
  const placed = []
  for (const j of imported) {
    const { body } = await api(`/jobs/${encodeURIComponent(j.id)}`)
    const loc = body?.data?.job?.location ?? ''
    const q = loc.split(/[,|;/]/)[0].trim()
    if (!q) continue
    const found = await api(`/locations?q=${encodeURIComponent(q)}`)
    const place = found.body?.data?.locations?.[0]
    if (place) placed.push({ ...j, place })
  }
  check(
    placed.length > 0,
    'at least one import names a known place',
    placed.map(p => p.place.label).join('; ')
  )
  for (const p of placed.slice(0, 2)) {
    const feed = await api(
      `/jobs?state=saved&near=${p.place.key}&radius_miles=25&include_remote=false&limit=100`
    )
    const hit = feed.body?.data?.jobs?.some(x => x.id === p.id)
    check(!!hit, `near=${p.place.key} finds ${p.source}'s import`)
  }

  if (target) {
    const blocked = await api('/blocked-companies', {
      method: 'PUT',
      body: JSON.stringify({ company: target.company })
    })
    check(blocked.status === 200, `block ${target.company}`)
    const feed = await api('/jobs?limit=100&sort=date')
    const leaked = feed.body.data.jobs.filter(
      x => x.company.trim().toLowerCase() === target.company.trim().toLowerCase()
    )
    check(leaked.length === 0, 'blocked employer gone from the feed', `${leaked.length} left`)
    const pipeStill = await api('/pipeline')
    check(
      pipeStill.body.data.items.some(i => i.job_id === target.id),
      'but still in the pipeline'
    )
    await api(`/blocked-companies?company=${encodeURIComponent(target.company)}`, {
      method: 'DELETE'
    })
  }
}

try {
  await main()
} finally {
  for (const id of touched) await api(`/jobs/${encodeURIComponent(id)}/state`, { method: 'DELETE' })
  const left = (await api('/pipeline')).body.data.items.filter(i => touched.has(i.job_id))
  console.log(`\ncleanup: cleared ${touched.size} state(s); ${left.length} left`)
  if (left.length) failures++
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
