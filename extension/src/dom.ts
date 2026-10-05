/** Small DOM tools for driving React-rendered forms the way a person would. */
import { normalize } from '../../src/components/matchOption'

export { normalize }

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Poll until `probe` returns something, or give up and return null. */
export async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 3000,
  stepMs = 100
): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit) return hit
    if (Date.now() > end) return null
    await sleep(stepMs)
  }
}

/** A question label without the required marker: "Email*" → "Email". */
export function cleanLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\s*✱]+$/u, '')
    .trim()
}

/**
 * Set a field's value so React sees it. React tracks the last value it wrote,
 * so assigning `.value` is ignored; the native setter plus an input event is
 * what a keystroke produces.
 */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Set a value and send the key events a typed character makes. For widgets
 * that search on keyup rather than on input — Lever's location box shows no
 * suggestions for a value set without them.
 */
export function typeWithKeys(el: HTMLInputElement, value: string): void {
  el.focus()
  setValue(el, value)
  const key = value.slice(-1) || ' '
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))
  }
}

export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus()
  setValue(el, value)
  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
}

/** A click with the mouse events a library listening for mousedown expects. */
export function press(el: Element): void {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
  ;(el as HTMLElement).click()
}

export function attachFile(input: HTMLInputElement, file: File): void {
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** The text a person reads as this control's label. */
export function labelFor(el: Element): string {
  const id = el.getAttribute('id')
  if (id) {
    const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (l?.textContent) return cleanLabel(l.textContent)
  }
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const l = document.getElementById(by.split(' ')[0] ?? '')
    if (l?.textContent) return cleanLabel(l.textContent)
  }
  const wrap = el.closest('label')
  return wrap?.textContent ? cleanLabel(wrap.textContent) : ''
}

/** Whether a person can see it — a hidden conditional question is not asked. */
export function visible(el: Element): boolean {
  return el.getClientRects().length > 0
}
