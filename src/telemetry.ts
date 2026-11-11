/**
 * What a visitor did, for monitoring-api's `service_events`.
 *
 * Every click on something clickable inside the app, every change of a
 * select / checkbox / radio, every form submit, every API call that failed
 * (including the ones that never reached the edge, which `request_logs` cannot
 * show), and every render crash. Batched, then POSTed to the worker's
 * `/telemetry` relay, which forwards each event as its own row
 * (`service=jobplatform`, `source=browser`, `context.app` = which UI).
 *
 * Clicks are caught by ONE delegated listener on the app's root, not wired per
 * button, so a button added later is recorded without anyone remembering to.
 * Name a control for the log with `data-telemetry="..."` when its visible text
 * is not a good name (an icon button, a text that changes); otherwise its
 * aria-label, title or text is used.
 *
 * Never recorded: what anyone types. Text inputs report nothing; a select
 * reports the option chosen, a checkbox whether it is now checked.
 *
 * Self-contained on purpose (no app imports) so JobPulse carries the same file.
 */

export type TelemetryApp = 'jobplatform' | 'jobpulse'
type Level = 'info' | 'warn' | 'error'
type PropValue = string | number | boolean | null

interface QueuedEvent {
  event: string
  level: Level
  at: number
  props: Record<string, PropValue>
}

/** The relay's own cap per request (worker/src/routes/telemetry.ts). */
const MAX_BATCH = 25
/** Longest string the relay accepts in a prop. */
const MAX_VALUE = 200
const FLUSH_MS = 5000
/** Anything clickable a person would call a control. */
const CONTROL = [
  '[data-telemetry]',
  'button',
  'a[href]',
  'summary',
  'label',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="link"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="submit"]',
  'input[type="button"]'
].join(',')

let endpoint = '/jobplatform/api/telemetry'
let app: TelemetryApp = 'jobplatform'
let session = ''
let queue: QueuedEvent[] = []
let timer: ReturnType<typeof setInterval> | undefined
let warned = false

function clip(v: string): string {
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE)
}

function newSession(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function route(): string {
  return clip(location.hash || location.pathname)
}

/** Queue one event. Safe to call before `startTelemetry` (it waits in the queue). */
export function track(
  event: string,
  props: Record<string, PropValue | undefined> = {},
  level: Level = 'info'
): void {
  const clean: Record<string, PropValue> = { route: route() }
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    clean[k] = typeof v === 'string' ? clip(v) : v
  }
  queue.push({ event, level, at: Date.now(), props: clean })
  if (queue.length >= MAX_BATCH) flush()
}

/** Send what is queued. `keepalive` lets it outlive a closing tab. */
export function flush(): void {
  if (!session || queue.length === 0) return
  const batch = queue.slice(0, MAX_BATCH)
  queue = queue.slice(MAX_BATCH)
  if (import.meta.env.DEV) {
    // The dev server proxies to production: keep a developer's clicks out of the real log.
    console.debug('[telemetry]', batch)
  } else {
    fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app, session, events: batch })
    })
      .then(res => {
        if (!res.ok) warnOnce(`relay answered ${res.status}`)
      })
      .catch((err: unknown) => warnOnce(err instanceof Error ? err.message : String(err)))
  }
  if (queue.length > 0) flush()
}

/** A lost batch is reported once per page, not once per batch: the console is not the log. */
function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  console.warn(`[telemetry] events not delivered: ${reason}`)
}

/** The name a person would give the control. */
function labelOf(el: Element): string {
  const named =
    el.getAttribute('data-telemetry') ??
    el.getAttribute('aria-label') ??
    el.getAttribute('title') ??
    (el instanceof HTMLInputElement ? (el.labels?.[0]?.textContent ?? el.name) : null) ??
    (el as HTMLElement).innerText ??
    el.textContent ??
    ''
  return clip(named) || el.tagName.toLowerCase()
}

function kindOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role) return role
  if (el instanceof HTMLInputElement) return `input:${el.type}`
  return el.tagName.toLowerCase()
}

function onClick(ev: MouseEvent): void {
  const target = ev.target instanceof Element ? ev.target.closest(CONTROL) : null
  if (!target) return
  // A <label> click re-dispatches to its input; record the input's own event, once.
  if (target.tagName === 'LABEL' && (target as HTMLLabelElement).control) return
  const props: Record<string, PropValue | undefined> = {
    label: labelOf(target),
    kind: kindOf(target),
    disabled: target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true'
  }
  if (target instanceof HTMLAnchorElement) {
    const url = new URL(target.href, location.href)
    props.href =
      url.origin === location.origin ? url.pathname + url.hash : url.origin + url.pathname
  }
  if (
    target instanceof HTMLInputElement &&
    (target.type === 'checkbox' || target.type === 'radio')
  ) {
    props.checked = target.checked
  }
  track('ui.click', props)
}

function onChange(ev: Event): void {
  const t = ev.target
  if (t instanceof HTMLSelectElement) {
    track('ui.change', {
      label: labelOf(t),
      kind: 'select',
      value: t.selectedOptions[0]?.textContent ?? t.value
    })
  }
  // Checkboxes and radios are recorded by their click; text never is.
}

function onSubmit(ev: SubmitEvent): void {
  const form = ev.target instanceof HTMLFormElement ? ev.target : null
  if (!form) return
  track('ui.submit', {
    label: clip(
      form.getAttribute('data-telemetry') ?? form.getAttribute('aria-label') ?? form.name ?? ''
    ),
    submitter: ev.submitter ? labelOf(ev.submitter) : undefined
  })
}

function onHide(): void {
  if (document.visibilityState === 'hidden') flush()
}

/**
 * Start recording inside `root`. Returns the stop function `unmount` calls,
 * which removes every listener and sends what is left.
 */
export function startTelemetry(
  root: HTMLElement,
  opts: { app: TelemetryApp; endpoint?: string }
): () => void {
  app = opts.app
  if (opts.endpoint) endpoint = opts.endpoint
  session = newSession()
  root.addEventListener('click', onClick, true)
  root.addEventListener('change', onChange, true)
  root.addEventListener('submit', onSubmit, true)
  document.addEventListener('visibilitychange', onHide)
  timer = setInterval(flush, FLUSH_MS)
  track('app.mounted', { path: location.pathname })
  return () => {
    root.removeEventListener('click', onClick, true)
    root.removeEventListener('change', onChange, true)
    root.removeEventListener('submit', onSubmit, true)
    document.removeEventListener('visibilitychange', onHide)
    clearInterval(timer)
    track('app.unmounted')
    flush()
  }
}

/**
 * `fetch`, recording every call that failed: a status of 400 and up, or no
 * answer at all. The second kind never reaches the edge, so this is the only
 * record of it. Successes are already in `request_logs` and are not repeated.
 */
export async function trackedFetch(input: string, init?: RequestInit): Promise<Response> {
  const started = performance.now()
  const path = clip(input.split('?')[0])
  const method = init?.method ?? 'GET'
  try {
    const res = await fetch(input, init)
    if (!res.ok) {
      track(
        'api.error',
        { method, path, status: res.status, ms: Math.round(performance.now() - started) },
        res.status >= 500 ? 'error' : 'warn'
      )
    }
    return res
  } catch (err) {
    track(
      'api.error',
      {
        method,
        path,
        status: 0,
        ms: Math.round(performance.now() - started),
        message: err instanceof Error ? err.message : String(err)
      },
      'error'
    )
    throw err
  }
}
