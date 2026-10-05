/** Lever (jobs.lever.co), ported from hadoku_scrape/apply/lever.py. */
import { matchOption } from '../../../src/components/matchOption'
import { answerFor, isMulti } from '../answers'
import {
  attachFile,
  cleanLabel,
  normalize,
  press,
  typeInto,
  typeWithKeys,
  visible,
  waitFor
} from '../dom'
import type { Packet } from '../messages'
import { answerControl, fillable, noAnswer, requiredEmpty, type FillReport } from './common'

const QUESTIONS = '.application-question'

function questionOf(q: Element): string {
  const t = q.querySelector('.application-label .text, .application-label, label')
  // The label text carries the required ✱ and, for a lone checkbox, nothing else.
  return cleanLabel((t?.firstChild?.textContent ?? t?.textContent ?? '').replace('✱', ''))
}

function field(name: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`)
}

/**
 * Lever keeps the location only if a suggestion from its own list is picked —
 * the hidden `selectedLocation` is what it submits. It searches on keystrokes,
 * by city: "Bothell" offers "Bothell, WA, USA".
 */
async function location(value: string): Promise<boolean> {
  const input = field('location')
  if (!input) return false
  const city = value.split(',')[0]?.trim() ?? value
  typeWithKeys(input, city)
  const opts = await waitFor(() => {
    const o = [...document.querySelectorAll<HTMLElement>('.dropdown-location')].filter(visible)
    return o.length ? o : null
  }, 6000)
  if (!opts) return false
  const texts = opts.map(o => (o.textContent ?? '').trim())
  const sameCity = texts.filter(t => normalize(t).startsWith(normalize(city)))
  const pick =
    sameCity.length === 1 ? sameCity[0] : (matchOption(value, texts) ?? sameCity[0] ?? null)
  const el = pick === undefined || pick === null ? null : opts[texts.indexOf(pick)]
  if (!el) return false
  press(el)
  const chosen = await waitFor(
    () => (document.querySelector<HTMLInputElement>('#selected-location')?.value ? true : null),
    2000
  )
  return chosen === true
}

export async function fillLever(
  packet: Packet,
  resume: File | null,
  report: FillReport
): Promise<void> {
  const p = packet.profile
  const done = new Set<string>()
  const simple: [string, string | null | undefined, string][] = [
    ['name', p?.name, 'Full name'],
    ['email', p?.email, 'Email'],
    ['phone', p?.phone, 'Phone'],
    [
      'org',
      answerFor(packet, 'Current company') ?? p?.work_experience?.find(w => w.current)?.company,
      'Current company'
    ],
    ['urls[LinkedIn]', p?.linkedin, 'LinkedIn URL'],
    ['urls[GitHub]', p?.github, 'GitHub URL']
  ]
  for (const [name, value, label] of simple) {
    const el = field(name)
    if (!el || !value) continue
    typeInto(el, value)
    report.filled.push(label)
    done.add(normalize(label))
  }
  if (resume) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"][name="resume"]')
    if (input) {
      attachFile(input, resume)
      report.filled.push('Résumé')
    }
  }
  if (p?.location && field('location')) {
    done.add('current location')
    if (await location(p.location)) report.filled.push('Current location')
    else report.refused.push(`Current location: “${p.location}” (pick it from Lever's list)`)
  }

  for (const q of document.querySelectorAll(QUESTIONS)) {
    if (!visible(q)) continue
    const question = questionOf(q)
    const key = normalize(question)
    if (!key || done.has(key)) continue
    // Not a question: "Apply with LinkedIn" is a button row, and the résumé
    // upload is attached above.
    if (!fillable(q) || q.querySelector('input[type="file"]')) continue
    // Fields already filled above sit inside .application-question too.
    const filledAlready = [
      ...q.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="email"]')
    ].some(i => i.value)
    if (filledAlready) continue
    done.add(key)
    const answer = answerFor(packet, question)
    if (answer === null) {
      noAnswer(report, q, question)
      continue
    }
    if (await answerControl(q, answer, isMulti(packet, question))) report.filled.push(question)
    else report.refused.push(`${question}: “${answer}”`)
  }

  for (const label of requiredEmpty(el => questionOf(el.closest(QUESTIONS) ?? el))) {
    if (
      !report.unanswered.includes(label) &&
      !report.refused.some(r => r.startsWith(`${label}:`))
    ) {
      report.unanswered.push(label)
    }
  }
}
