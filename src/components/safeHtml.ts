/**
 * A posting's description, cut down to formatting before it is rendered as
 * HTML.
 *
 * Descriptions come from outside: board APIs, and since POST /jobs/import any
 * careers page's JSON-LD, which any friend-tier caller can point at a page
 * they control. The corpus is shared, so markup stored from one import renders
 * in everyone's drawer on hadoku.me. Only formatting survives here: an
 * allowlist of tags, no attributes but an http(s) link's href, and nothing at
 * all from a script, style or embed (their text included).
 *
 * DOMParser builds an inert document: nothing in it runs or loads while it is
 * parsed or walked. No dependency, so the boot bundle stays inside its budget.
 */

const KEEP = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
])

/** Gone with everything inside them: their text is code or chrome, not prose. */
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'svg',
  'math',
  'head',
  'title',
  'form',
  'select',
  'textarea',
  'button'
])

function safeHref(href: string | null): string | null {
  if (!href) return null
  try {
    const url = new URL(href, 'https://invalid.example/')
    if (url.origin === 'https://invalid.example') return null // relative: it would point at hadoku.me
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    // An href URL() cannot parse cannot be a safe link either.
    return null
  }
}

function clean(from: Node, into: Node, doc: Document): void {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.textContent ?? ''))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue // comments, processing instructions
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    if (DROP.has(tag)) continue
    if (!KEEP.has(tag)) {
      // Unknown wrapper (font, section, img…): keep its text, lose the element.
      clean(el, into, doc)
      continue
    }
    const out = doc.createElement(tag)
    if (tag === 'a') {
      const href = safeHref(el.getAttribute('href'))
      if (href) {
        out.setAttribute('href', href)
        out.setAttribute('target', '_blank')
        out.setAttribute('rel', 'noopener noreferrer nofollow')
      }
    }
    clean(el, out, doc)
    into.appendChild(out)
  }
}

export function safeHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const root = out.createElement('div')
  clean(parsed.body, root, out)
  return root.innerHTML
}
