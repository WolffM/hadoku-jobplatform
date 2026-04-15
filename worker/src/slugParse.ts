/**
 * Parse (ats, slug) from a job posting URL.
 *
 * Returns `null` fields when the URL doesn't match a known pattern — callers
 * should treat that as "unknown provenance" rather than an error. Backfillable
 * later by a one-off route that re-parses existing rows.
 *
 * Source-of-truth tests (update this block when adding patterns):
 *
 *   https://jobs.lever.co/mistral/3eef7a1f-cd9d-...                → (lever, mistral)
 *   https://jobs.lever.co/plaid/aed3a2ea-6f19-...                  → (lever, plaid)
 *   https://boards.greenhouse.io/anthropic/jobs/7532733            → (greenhouse, anthropic)
 *   https://job-boards.greenhouse.io/anthropic/jobs/5170084008     → (greenhouse, anthropic)  [new canonical host]
 *   https://stripe.com/jobs/search?gh_jid=7532733                  → (greenhouse, stripe)     [custom-domain shortlink]
 *   https://databricks.com/company/careers/.../job?gh_jid=...      → (greenhouse, databricks) [custom-domain shortlink]
 *   https://jobs.ashbyhq.com/ramp/abc-123                          → (ashby, ramp)
 *   https://www.linkedin.com/jobs/view/4012345678                  → (linkedin, null)         [no slug in URL]
 */

export interface AtsSlug {
	ats: string | null;
	slug: string | null;
}

const LEVER_RE = /^https?:\/\/jobs\.lever\.co\/([^/?#]+)/i;
// Greenhouse historically used boards.greenhouse.io; newer tarball uses job-boards.greenhouse.io.
// Support both.
const GREENHOUSE_BOARDS_RE = /^https?:\/\/(?:job-)?boards\.greenhouse\.io\/([^/?#]+)/i;
const ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i;
const LINKEDIN_RE = /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/jobs\//i;

// Hostname subdomain prefixes to strip when deriving a slug from a custom
// careers domain (e.g. "careers.anthropic.com" → slug "anthropic").
const HOSTNAME_PREFIX_NOISE = new Set(['www', 'careers', 'jobs', 'hire', 'hiring', 'work']);

/**
 * Derive a company slug from a custom careers domain.
 *   databricks.com          → databricks
 *   www.stripe.com          → stripe
 *   careers.anthropic.com   → anthropic
 *   jobs.example.co.uk      → example
 * Returns null if the hostname is empty or all labels are noise.
 */
function slugFromHost(host: string): string | null {
	const labels = host
		.toLowerCase()
		.split('.')
		.filter((l) => l && !HOSTNAME_PREFIX_NOISE.has(l));
	if (labels.length === 0) return null;
	// Drop the TLD-ish suffix(es). For .com/.io/.co → just drop the last label.
	// For .co.uk/.com.au → drop the last two. Approximate via "if 2nd-to-last is 2 chars".
	let end = labels.length - 1;
	if (end >= 1 && labels[end].length <= 3 && labels[end - 1].length <= 3) {
		end -= 1;
	}
	return labels.slice(0, end).join('.') || labels[0];
}

export function parseAtsSlug(url: string): AtsSlug {
	if (!url) return { ats: null, slug: null };

	let match = LEVER_RE.exec(url);
	if (match) return { ats: 'lever', slug: match[1].toLowerCase() };

	match = GREENHOUSE_BOARDS_RE.exec(url);
	if (match) return { ats: 'greenhouse', slug: match[1].toLowerCase() };

	match = ASHBY_RE.exec(url);
	if (match) return { ats: 'ashby', slug: match[1].toLowerCase() };

	if (LINKEDIN_RE.test(url)) {
		// LinkedIn URLs don't carry a company slug — the scraper knows it from the
		// search term, but it doesn't reach us today. Store ats only.
		return { ats: 'linkedin', slug: null };
	}

	// Generic greenhouse shortlinks: any URL carrying `gh_jid=` is a greenhouse
	// posting, regardless of host. Derive slug from the hostname.
	if (url.includes('gh_jid=')) {
		try {
			const host = new URL(url).hostname;
			const slug = slugFromHost(host);
			if (slug) return { ats: 'greenhouse', slug };
		} catch {
			// Malformed URL — fall through to unknown
		}
	}

	return { ats: null, slug: null };
}
