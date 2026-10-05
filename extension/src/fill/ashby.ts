/** Ashby (jobs.ashbyhq.com), ported from hadoku_scrape/apply/ashby.py. */
import { matchOption } from '../../../src/components/matchOption'
import { answerFor, isMulti } from '../answers'
import { attachFile, cleanLabel, normalize, press, typeInto, visible, waitFor } from '../dom'
import type { Packet } from '../messages'
import { answerControl, fillable, noAnswer, requiredEmpty, type FillReport } from './common'

const ENTRIES = '.ashby-application-form-field-entry, fieldset'

function titleOf(entry: Element): string {
  const t = entry.querySelector('.ashby-application-form-question-title, label, legend')
  return cleanLabel(t?.textContent ?? '')
}

async function location(entry: Element, value: string): Promise<boolean> {
  const input = entry.querySelector<HTMLInputElement>('input[role="combobox"], input[type="text"]')
  if (!input) return false
  typeInto(input, value)
  input.focus()
  const opts = await waitFor(() => {
    const o = [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter(visible)
    return o.length ? o : null
  }, 5000)
  if (!opts) return false
  const texts = opts.map(o => (o.textContent ?? '').trim())
  const city = normalize(value.split(',')[0] ?? value)
  const pick = matchOption(value, texts) ?? texts.find(t => normalize(t).startsWith(city)) ?? null
  const el = pick === null ? null : opts[texts.indexOf(pick)]
  if (!el) return false
  press(el)
  return true
}

export async function fillAshby(
  packet: Packet,
  resume: File | null,
  report: FillReport
): Promise<void> {
  const done = new Set<string>()
  for (const entry of document.querySelectorAll(ENTRIES)) {
    if (!visible(entry)) continue
    const question = titleOf(entry)
    const key = normalize(question)
    if (!key || done.has(key)) continue
    done.add(key)

    if (key === 'resume' || key === 'resume cv') {
      const input = entry.querySelector<HTMLInputElement>('input[type="file"]')
      if (input && resume) {
        attachFile(input, resume)
        report.filled.push(question)
      }
      continue
    }
    if (key === 'location' && packet.profile?.location) {
      if (await location(entry, packet.profile.location)) report.filled.push(question)
      else report.refused.push(`${question}: “${packet.profile.location}”`)
      continue
    }

    if (!fillable(entry)) continue
    const answer = answerFor(packet, question)
    if (answer === null) {
      noAnswer(report, entry, question)
      continue
    }
    const yesno = entry.querySelectorAll<HTMLButtonElement>(
      'button.ashby-application-form-input-yesno-option'
    )
    if (yesno.length) {
      const pick = matchOption(answer, ['Yes', 'No'])
      const button = pick
        ? entry.querySelector<HTMLButtonElement>(`button[data-option="${pick.toLowerCase()}"]`)
        : null
      if (button) {
        press(button)
        report.filled.push(question)
      } else report.refused.push(`${question}: “${answer}”`)
      continue
    }
    if (await answerControl(entry, answer, isMulti(packet, question))) report.filled.push(question)
    else report.refused.push(`${question}: “${answer}”`)
  }

  for (const label of requiredEmpty(el => titleOf(el.closest(ENTRIES) ?? el))) {
    if (
      !report.unanswered.includes(label) &&
      !report.refused.some(r => r.startsWith(`${label}:`))
    ) {
      report.unanswered.push(label)
    }
  }
}
