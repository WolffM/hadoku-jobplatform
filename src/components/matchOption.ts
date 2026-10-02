/**
 * The option on a board that says what an answer says — or null.
 *
 * MIRRORS `matchOption` in worker/src/questionFamily.ts, which is the source of
 * truth: the worker uses it to pre-fill each question's suggestion, and the
 * dashboard uses this copy when the owner types one answer for a whole family
 * and applies it to every wording. If the two disagreed, "Apply to all" would
 * pick a different option than the suggestion beside it.
 *
 * worker/tests/matchOptionParity.test.ts runs both over the same cases and
 * fails on any drift. Kept free of imports so that test can load it directly.
 */

/** Mirrors worker/src/questionKey.ts `questionKey`. */
function normalize(text: string): string {
  return text
    .replace(/\*/g, ' ')
    .toLowerCase()
    .replace(/n't\b/g, ' not ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function matchOption(answer: string, options: string[]): string | null {
  const a = answer.trim()
  if (!a) return null
  if (options.length === 0) return a

  const na = normalize(a)
  const exact = options.filter(o => normalize(o) === na)
  if (exact.length === 1) return exact[0] ?? null

  const lead = na.split(' ')[0]
  if (lead === 'yes' || lead === 'no') {
    const same = options.filter(o => normalize(o).split(' ')[0] === lead)
    return same.length === 1 ? (same[0] ?? null) : null
  }

  const within = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `)
  const hits = options.filter(o => {
    const no = normalize(o)
    return within(no, na) || within(na, no)
  })
  return hits.length === 1 ? (hits[0] ?? null) : null
}
