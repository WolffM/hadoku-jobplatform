/**
 * Greenhouse (job-boards.greenhouse.io), ported from the runner's
 * hadoku_scrape/apply/greenhouse.py: the same groups, ids and order.
 */
import { answerFor, isMulti } from '../answers'
import { attachFile, cleanLabel, labelFor, normalize, typeInto, visible } from '../dom'
import type { Packet } from '../messages'
import {
  answerControl,
  commitCombobox,
  fillable,
  noAnswer,
  requiredEmpty,
  type FillReport
} from './common'

/** One wrapper can hold two questions (Hispanic/Latino, then race), so each select is its own group. */
const GROUPS =
  '.field-wrapper, .eeoc__question__wrapper .select, .application--form fieldset, ' +
  '.demographic--container .select, .application--form > .checkbox'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function month(m: string | number | undefined): string {
  const n = Number(m)
  return Number.isInteger(n) && n >= 1 && n <= 12 ? (MONTHS[n - 1] ?? '') : String(m ?? '')
}

function byId(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null
}

function text(
  id: string,
  value: string | number | undefined,
  report: FillReport,
  done: Set<string>
): void {
  const el = byId(id)
  if (!el || value === undefined || value === '') return
  typeInto(el, String(value))
  done.add(normalize(labelFor(el)))
  report.filled.push(labelFor(el) || id)
}

async function combo(id: string, value: string | undefined, report: FillReport, done: Set<string>) {
  const el = byId(id)
  if (!el || !value) return
  const label = labelFor(el) || id
  done.add(normalize(label))
  if (await commitCombobox(el, value)) report.filled.push(label)
  else report.refused.push(`${label}: “${value}”`)
}

export async function fillGreenhouse(
  packet: Packet,
  resume: File | null,
  report: FillReport
): Promise<void> {
  const p = packet.profile
  const done = new Set<string>()

  if (p) {
    const [first, ...rest] = p.name.split(' ')
    text('first_name', first, report, done)
    text('last_name', rest.join(' ') || first, report, done)
    text('email', p.email, report, done)
    text('phone', p.phone, report, done)
  }

  if (resume) {
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]#resume') ??
      document.querySelector<HTMLInputElement>('input[type="file"][id*="resume" i]')
    if (input) {
      attachFile(input, resume)
      report.filled.push('Résumé')
      done.add(normalize(labelFor(input) || 'resume'))
    }
  }

  // Work history and education: structured blocks with fixed ids.
  for (const [i, job] of (p?.work_experience ?? []).entries()) {
    if (!byId(`company-name-${i}`)) break
    text(`company-name-${i}`, job.company, report, done)
    text(`title-${i}`, job.title, report, done)
    await combo(`start-date-month-${i}`, month(job.start_month), report, done)
    text(`start-date-year-${i}`, job.start_year, report, done)
    const current = byId(`current-role-${i}_1`)
    if (job.current && current) {
      if (!current.checked) current.click()
      done.add(normalize(labelFor(current)))
    } else if (!job.current) {
      await combo(`end-date-month-${i}`, month(job.end_month), report, done)
      text(`end-date-year-${i}`, job.end_year, report, done)
    }
  }
  for (const [i, school] of (p?.education ?? []).entries()) {
    if (!byId(`school--${i}`)) break
    await combo(`school--${i}`, school.school, report, done)
    await combo(`degree--${i}`, school.degree, report, done)
    await combo(`discipline--${i}`, school.discipline, report, done)
    for (const [edge, year, verb] of [
      ['start', school.start_year, 'start at'],
      ['end', school.end_year, 'graduate from']
    ] as const) {
      const id = byId(`${edge}-year--${i}`) ? `${edge}-year--${i}` : `${edge}-date-year--${i}`
      const value =
        year ?? answerFor(packet, `What year did you ${verb} ${school.school}?`) ?? undefined
      text(id, value, report, done)
    }
  }

  // Every other question, by its label — answered from the approved fill first.
  for (const group of document.querySelectorAll(GROUPS)) {
    if (!visible(group)) continue
    const labelEl = group.querySelector('label, legend')
    const question = cleanLabel(labelEl?.textContent ?? '')
    const key = normalize(question)
    if (!key || done.has(key)) continue
    done.add(key)
    // Upload fields (résumé, cover letter) are not questions: the résumé is
    // attached above, and the runner never sent a cover letter either.
    if (group.querySelector('input[type="file"]') || !fillable(group)) continue
    const answer = answerFor(packet, question)
    if (answer === null) {
      noAnswer(report, group, question)
      continue
    }
    if (await answerControl(group, answer, isMulti(packet, question))) report.filled.push(question)
    else report.refused.push(`${question}: “${answer}”`)
  }

  for (const label of requiredEmpty(el => {
    const g = el.closest(GROUPS)
    return cleanLabel(g?.querySelector('label, legend')?.textContent ?? labelFor(el))
  })) {
    if (
      !report.unanswered.includes(label) &&
      !report.refused.some(r => r.startsWith(`${label}:`))
    ) {
      report.unanswered.push(label)
    }
  }
}
