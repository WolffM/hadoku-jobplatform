/**
 * The panel on an application page: Fill, the verification code if one has
 * arrived, and "Mark sent" once the board says it has the application.
 *
 * It fills; it never submits and never types a verification code. The owner
 * reviews the form, presses the board's own Submit, and types the code —
 * every board we apply through checks for a person at exactly that step, and
 * the person is the owner.
 */
import { pageJob, type PageJob } from './ats'
import { waitFor } from './dom'
import { ask, type Code, type Packet } from './messages'
import { newReport, type FillReport } from './fill/common'
import { fillGreenhouse } from './fill/greenhouse'
import { fillAshby } from './fill/ashby'
import { fillLever } from './fill/lever'

/** Text a board shows once it has the application. */
const CONFIRMED =
  /thank you for (applying|your application)|thanks for applying|application (has been |was )?(submitted|received)|we('ve| have) received your application/i

const STYLE = `
:host { all: initial; }
.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 320px;
  max-height: 70vh; overflow: auto; font: 13px/1.4 system-ui, sans-serif; color: #1d2433;
  background: #fbfaf7; border: 1px solid #c9c4b8; border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 12px; }
@media (prefers-color-scheme: dark) {
  .panel { color: #e8e6e1; background: #23262d; border-color: #444955; } }
h1 { font-size: 13px; margin: 0 0 4px; }
.job { opacity: .8; margin-bottom: 8px; }
.row { display: flex; gap: 8px; margin: 8px 0; }
button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #8a8577;
  background: transparent; color: inherit; cursor: pointer; }
button.primary { background: #2f5d50; border-color: #2f5d50; color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.code { font: 600 20px/1.2 ui-monospace, monospace; letter-spacing: .08em; }
ul { margin: 4px 0 8px; padding-left: 18px; }
.warn { color: #9a4b00; } .err { color: #b3261e; } .ok { color: #2f6b3a; }
@media (prefers-color-scheme: dark) { .warn { color: #f0b46b; } .err { color: #f2a19a; } .ok { color: #9fd3a8; } }
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...kids)
  return node
}

function list(title: string, items: string[], cls: string): HTMLElement {
  const wrap = el('div', { className: cls })
  wrap.append(
    el('strong', {}, `${title} (${items.length})`),
    el('ul', {}, ...items.map(i => el('li', {}, i)))
  )
  return wrap
}

function decodePdf(base64: string, name: string): File {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'application/pdf' })
}

async function fill(job: PageJob, packet: Packet): Promise<FillReport> {
  let resume: File | null = null
  if (packet.resume_pdf_url) {
    const pdf = await ask<string>({ type: 'pdf', url: packet.resume_pdf_url })
    if (pdf.ok) resume = decodePdf(pdf.data, `${packet.profile?.name ?? 'Resume'} - Resume.pdf`)
  }
  const report = newReport()
  if (job.ats === 'greenhouse') await fillGreenhouse(packet, resume, report)
  else if (job.ats === 'ashby') await fillAshby(packet, resume, report)
  else await fillLever(packet, resume, report)
  if (packet.resume_pdf_url && !resume) report.refused.push('Résumé: the PDF could not be fetched')
  if (!packet.resume_pdf_url) {
    report.unanswered.push('Résumé — no tailored résumé was made for this job; attach one yourself')
  }
  return report
}

function mount(job: PageJob): void {
  const host = el('div', { id: 'hadoku-fill' })
  const root = host.attachShadow({ mode: 'open' })
  root.append(el('style', {}, STYLE))
  const panel = el('div', { className: 'panel' })
  root.append(panel)
  document.documentElement.append(host)
  // Greenhouse is a Remix app that hydrates the whole document, and hydration
  // removes nodes it did not render — this panel included, a moment after it
  // appears. Put it back; its state lives on the element, so nothing is lost.
  const keep = window.setInterval(() => {
    if (!host.isConnected) document.documentElement.append(host)
  }, 500)

  const status = el('div')
  const results = el('div')
  const codes = el('div')
  const fillBtn = el('button', { className: 'primary', textContent: 'Fill' })
  const sentBtn = el('button', { textContent: 'Mark sent', disabled: true })
  const closeBtn = el('button', { textContent: '×', title: 'Hide' })
  const jobLine = el('div', { className: 'job', textContent: 'Loading your packet…' })
  panel.append(
    el('h1', {}, 'hadoku Fill'),
    jobLine,
    el('div', { className: 'row' }, fillBtn, sentBtn, closeBtn),
    status,
    results,
    codes
  )
  closeBtn.onclick = () => {
    window.clearInterval(keep)
    host.remove()
  }

  let packet: Packet | null = null
  let filled = false
  let sent = false

  async function markSent(auto: boolean) {
    if (sent || !packet?.application) return
    sent = true
    const res = await ask({ type: 'markSent', applicationId: packet.application.id })
    status.className = res.ok ? 'ok' : 'err'
    status.textContent = res.ok
      ? auto
        ? 'The board confirmed it — marked sent.'
        : 'Marked sent.'
      : `Could not mark it sent: ${res.error}`
    sentBtn.disabled = true
  }

  void ask<Packet>({ type: 'packet', jobId: job.jobId }).then(res => {
    if (!res.ok) {
      jobLine.textContent = `No packet: ${res.error}`
      jobLine.className = 'err'
      fillBtn.disabled = true
      return
    }
    packet = res.data
    const app = packet.application
    jobLine.textContent = `${packet.job.company} — ${packet.job.title}${app ? ` · ${app.status}` : ' · not queued'}`
    if (!packet.profile) {
      status.className = 'warn'
      status.textContent = 'No applicant profile on hadoku yet — only saved answers will be filled.'
    }
    sentBtn.disabled = !app || app.status === 'submitted'
  })

  fillBtn.onclick = async () => {
    if (!packet) return
    fillBtn.disabled = true
    status.className = ''
    status.textContent = 'Filling…'
    try {
      const report = await fill(job, packet)
      filled = true
      status.className = report.unanswered.length || report.refused.length ? 'warn' : 'ok'
      status.textContent =
        report.unanswered.length || report.refused.length
          ? 'Filled what it could — check the items below, then Submit.'
          : 'Filled. Review the form, then press Submit.'
      results.replaceChildren(
        ...(report.refused.length ? [list("Couldn't enter", report.refused, 'err')] : []),
        ...(report.unanswered.length ? [list('Needs you', report.unanswered, 'warn')] : []),
        ...(report.optional.length ? [list('Left blank (optional)', report.optional, '')] : []),
        list('Filled', report.filled, '')
      )
    } catch (err) {
      status.className = 'err'
      status.textContent = `Fill failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      fillBtn.disabled = false
    }
  }
  sentBtn.onclick = () => void markSent(false)

  // The board's own confirmation, after this panel filled the form.
  new MutationObserver(() => {
    if (filled && !sent && CONFIRMED.test(document.body.innerText)) void markSent(true)
  }).observe(document.body, { childList: true, subtree: true, characterData: true })

  // Greenhouse emails a code at submit; show it here as well as on the dashboard.
  if (job.ats === 'greenhouse') {
    const poll = async () => {
      const res = await ask<Code[]>({ type: 'codes' })
      if (!res.ok || !packet) return
      const company = packet.job.company.toLowerCase()
      const mine = res.data.filter(
        c => !c.company || company.includes(c.company) || c.company.includes(company)
      )
      const latest = mine[0]
      if (!latest) {
        codes.replaceChildren()
        return
      }
      const mins = Math.round((Date.now() - new Date(latest.received_at).getTime()) / 60_000)
      codes.replaceChildren(
        el('strong', {}, `Verification code (${mins < 1 ? 'just now' : `${mins} min ago`})`),
        latest.code
          ? el('div', { className: 'code' }, latest.code)
          : el('pre', {}, latest.text ?? '')
      )
    }
    void poll()
    setInterval(() => void poll(), 10_000)
  }
}

const job = pageJob(location.href)
// The form, not a listing page: every board puts a file input on the form —
// once React has rendered it, which can be well after document_idle.
if (job) {
  void waitFor(() => document.querySelector('input[type="file"]'), 20000, 250).then(form => {
    if (form) mount(job)
  })
}
