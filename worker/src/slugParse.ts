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
 *   https://stripe.com/jobs/search?gh_jid=7532733                  → (greenhouse, stripe)  [shortlink]
 *   https://jobs.ashbyhq.com/ramp/abc-123                          → (ashby, ramp)
 *   https://www.linkedin.com/jobs/view/4012345678                  → (linkedin, null)     [no slug in URL]
 */

export interface AtsSlug {
	ats: string | null;
	slug: string | null;
}

const LEVER_RE = /^https?:\/\/jobs\.lever\.co\/([^/?#]+)/i;
const GREENHOUSE_BOARDS_RE = /^https?:\/\/boards\.greenhouse\.io\/([^/?#]+)/i;
const ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i;
const LINKEDIN_RE = /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/jobs\//i;

// Stripe's careers page is a greenhouse shortlink; the slug is implied, not in the URL.
const GREENHOUSE_SHORTLINKS: Record<string, string> = {
	'stripe.com': 'stripe',
};

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

	// Greenhouse shortlinks on custom domains (e.g. stripe.com/jobs/search?gh_jid=…).
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
		if (host in GREENHOUSE_SHORTLINKS && url.includes('gh_jid=')) {
			return { ats: 'greenhouse', slug: GREENHOUSE_SHORTLINKS[host] };
		}
	} catch {
		// Malformed URL — fall through to unknown
	}

	return { ats: null, slug: null };
}
