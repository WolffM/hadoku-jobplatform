/** Answering one question, whatever control it is. Shared by every board. */
import { matchOption } from '../../../src/components/matchOption'
import { normalize, press, setValue, sleep, typeInto, visible, waitFor } from '../dom'
import { AFFIRMATIVE, splitAnswer } from '../answers'

export interface FillReport {
  filled: string[]
  /** Required questions with no answer in the packet — left for the owner. */
  unanswered: string[]
  /** Optional questions left blank. Listed, but nothing waits on them. */
  optional: string[]
  /** Questions that had an answer the form would not take. */
  refused: string[]
}

export function newReport(): FillReport {
  return { filled: [], unanswered: [], optional: [], refused: [] }
}

/** Whether the board marks this question required, by attribute or by its ✱/*. */
export function isRequired(group: Element): boolean {
  if (group.querySelector('[required], [aria-required="true"], .required')) return true
  const label = group.querySelector('label, legend, .application-label')?.textContent ?? ''
  return /[*✱]\s*$/u.test(label.trim())
}

/** Whether a group holds anything a person types into or picks — not a button row. */
export function fillable(group: Element): boolean {
  return !!group.querySelector(
    'input:not([type="hidden"]):not([type="file"]), textarea, select, button.ashby-application-form-input-yesno-option'
  )
}

/** Record a question nothing answered, as required or optional. */
export function noAnswer(report: FillReport, group: Element, question: string): void {
  if (isRequired(group)) report.unanswered.push(question)
  else report.optional.push(question)
}

/** The visible text of each option a react-select menu is showing. */
function menuOptions(input: HTMLInputElement): HTMLElement[] {
  const id = input.id
  const own = id
    ? document.querySelectorAll<HTMLElement>(`[id^="react-select-${CSS.escape(id)}-option-"]`)
    : []
  if (own.length) return [...own]
  // Unscoped fallback: the one open listbox on the page.
  return [
    ...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"], [id*="-option-"]')
  ].filter(visible)
}

/**
 * Could `shown` be this board's wording of `intended`? A port of the runner's
 * `option_consistent` (hadoku_scrape/apply/base.py): word-bounded, so "Male"
 * never accepts "Female"; the first intended word must appear whole and each
 * later one may start a shown word, so "Bothell, WA" accepts "Bothell,
 * Washington, United States".
 */
export function optionConsistent(intended: string, shown: string): boolean {
  const a = intended.trim().toLowerCase()
  const b = shown.trim().toLowerCase()
  if (!b) return false
  if (a === b) return true
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\b${esc}\\b`).test(b)) return true
  const want: string[] = a.match(/[a-z0-9]+/g) ?? []
  const have: string[] = b.match(/[a-z0-9]+/g) ?? []
  if (!want.length || !have.includes(want[0] ?? '')) return false
  return want.slice(1).every(t => have.some(w => w.startsWith(t)))
}

/**
 * Commit one value into a react-select combobox the way the runner does, so it
 * picks what the approved fill picked:
 *
 * 1. Type the value. The option that says the same thing (`matchOption`) wins;
 *    failing that, the first filtered option if it is consistent with the
 *    value — what the runner's Enter committed ("(US) Washington" for
 *    "Washington", "Bothell, Washington, United States" for "Bothell, WA").
 * 2. Otherwise clear the box, open the full list, and choose by `matchOption`
 *    — a long answer that filtering hides, or a reworded one ("No, I do not…"
 *    against "No, I don't…").
 *
 * Never presses Enter on an empty menu: that once submitted a whole form.
 */
export async function commitCombobox(input: HTMLInputElement, value: string): Promise<boolean> {
  const attempts: { query: string; firstOk: boolean }[] = [
    { query: value, firstOk: true },
    { query: '', firstOk: false }
  ]
  for (const { query, firstOk } of attempts) {
    input.focus()
    if (query) {
      press(input)
      setValue(input, query)
    } else {
      // Clearing a failed search reopens the full list by itself; a press on a
      // menu that is already open would close it, so press only if it did not.
      setValue(input, '')
      await sleep(300)
      if (!menuOptions(input).length) press(input)
    }
    const opts = await waitFor(() => {
      const o = menuOptions(input)
      return o.length ? o : null
    }, 4000)
    if (!opts) continue
    const texts = opts.map(o => (o.textContent ?? '').trim())
    let pick = matchOption(value, texts)
    if (pick === null && firstOk && texts[0] !== undefined && optionConsistent(value, texts[0])) {
      pick = texts[0]
    }
    if (pick === null) continue
    const el = opts[texts.indexOf(pick)]
    if (!el) continue
    press(el)
    await sleep(150)
    return true
  }
  setValue(input, '')
  input.blur()
  return false
}

export async function answerControl(
  group: Element,
  answer: string,
  multi: boolean
): Promise<boolean> {
  const combo = group.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (combo) {
    const values = multi ? splitAnswer(answer) : [answer]
    for (const v of values) if (!(await commitCombobox(combo, v))) return false
    return true
  }

  const select = group.querySelector('select')
  if (select) {
    const opts = [...select.options].filter(o => o.value)
    const pick = matchOption(
      answer,
      opts.map(o => o.text.trim())
    )
    const opt = opts.find(o => o.text.trim() === pick)
    if (!opt) return false
    select.value = opt.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  const boxes = [
    ...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
  ]
  if (boxes.length === 1 && boxes[0]?.type === 'checkbox') {
    // A lone checkbox is the question itself — a consent. Ticked on a plain yes only.
    if (!AFFIRMATIVE.has(normalize(answer))) return false
    if (!boxes[0].checked) press(boxes[0])
    return boxes[0].checked
  }
  if (boxes.length) {
    const labelled = boxes.map(b => ({ b, text: optionLabel(b) }))
    const values = splitAnswer(answer)
    const picks = values.map(v =>
      matchOption(
        v,
        labelled.map(l => l.text)
      )
    )
    if (picks.some(p => p === null)) return false
    for (const { b, text } of labelled) {
      if (picks.includes(text) && !b.checked) press(b.closest('label') ?? b)
    }
    return labelled.filter(l => picks.includes(l.text)).every(l => l.b.checked)
  }

  const area = group.querySelector('textarea')
  if (area) {
    typeInto(area, answer)
    return true
  }
  const box = group.querySelector<HTMLInputElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type])'
  )
  if (box) {
    typeInto(box, answer)
    return true
  }
  return false
}

/** An option's own text: its label[for], its wrapping label, or its value. */
export function optionLabel(input: HTMLInputElement): string {
  const byFor = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null
  const text = (byFor ?? input.closest('label'))?.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim() || input.value
}

/**
 * Required fields still empty after filling — what the board would refuse.
 * Same idea as the runner's sweep: native validity, aria-required text fields,
 * and a radio/checkbox group counted once.
 */
export function requiredEmpty(labelOf: (el: Element) => string): string[] {
  const out = new Set<string>()
  const seenGroups = new Set<string>()
  for (const el of document.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >('input, textarea, select')) {
    if (el instanceof HTMLInputElement && (el.type === 'file' || el.type === 'hidden')) continue
    if (el.disabled || !visible(el.closest('div') ?? el)) continue
    const native = el.willValidate && el.validity.valueMissing
    const aria =
      el.getAttribute('aria-required') === 'true' &&
      el.getAttribute('role') !== 'combobox' &&
      !String(el.value).trim()
    if (!native && !aria) continue
    if (
      el instanceof HTMLInputElement &&
      (el.type === 'radio' || el.type === 'checkbox') &&
      el.name
    ) {
      if (seenGroups.has(el.name)) continue
      seenGroups.add(el.name)
      const group = document.querySelectorAll<HTMLInputElement>(
        `input[name="${CSS.escape(el.name)}"]`
      )
      if ([...group].some(b => b.checked)) continue
    }
    const label = labelOf(el)
    if (label) out.add(label)
  }
  return [...out]
}
