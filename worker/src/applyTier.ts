/**
 * Can the form runner drive this posting's application, and do we KNOW it can?
 *
 * Two different claims, kept apart on purpose.
 *
 * `apply_tier` is a PREDICTION read off the URL. It says an adapter exists for
 * this shape of posting, nothing more — no page has been opened.
 *
 * `apply_verified` is EVIDENCE: a form on this same board has actually been
 * filled by the runner. That is the only thing entitled to read as "we checked".
 *
 * Collapsing the two would put a confident badge on a guess, which is the
 * failure this whole subsystem keeps having to unlearn.
 *
 * KEEP IN STEP WITH the adapter table in hadoku-scrape:
 * `hadoku_scrape/apply/runner.py::ADAPTERS`. That module is the source of
 * truth — it is what actually drives the browser — and this is a copy for the
 * UI, because the two live in different languages and different processes.
 */

/**
 * - `supported`   a proven adapter matches this host outright.
 * - `embedded`    the employer serves its own careers page, but the form
 *                 underneath is Greenhouse and is reachable at that board's
 *                 embed URL. Verified 2026-09-01 against Coinbase: the
 *                 canonical board URL 302s TO the company domain, while
 *                 `job-boards.greenhouse.io/embed/job_app?for=…&token=…` still
 *                 serves the real form, and the Greenhouse adapter filled it.
 * - `unsupported` a real ATS we have no adapter for. Honest "no", not "unknown".
 * - `unknown`     nothing recognisable. No claim either way.
 */
export type ApplyTier = 'supported' | 'embedded' | 'unsupported' | 'unknown';

/** Hosts a proven adapter drives directly. */
const SUPPORTED_HOSTS = [
	'jobs.ashbyhq.com',
	'job-boards.greenhouse.io',
	'boards.greenhouse.io',
	'jobs.lever.co',
];

/**
 * A Greenhouse posting served from the employer's own domain carries its id in
 * the query string. `gh_jid` is Greenhouse's own embed parameter, so its
 * presence identifies the ATS even when the hostname does not.
 */
const EMBED_QUERY_KEYS = ['gh_jid', 'token'];

/** Real ATSes with no adapter yet — worth saying so rather than shrugging. */
const KNOWN_UNSUPPORTED = [
	'myworkdayjobs.com',
	'smartrecruiters.com',
	'workable.com',
	'icims.com',
	'taleo.net',
	'bamboohr.com',
	'jobvite.com',
	'breezy.hr',
];

export function applyTier(applicationUrl: string | null, ats: string | null): ApplyTier {
	const raw = (applicationUrl ?? '').trim();
	if (!raw) return 'unknown';

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return 'unknown';
	}
	const host = url.hostname.toLowerCase();

	if (SUPPORTED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'supported';

	// Order matters: an embedded Greenhouse posting lives on an unrecognised
	// host, so the embed test has to run before the host is written off.
	const hasEmbedId = EMBED_QUERY_KEYS.some((k) => url.searchParams.get(k));
	if (hasEmbedId && (ats ?? '').toLowerCase() === 'greenhouse') return 'embedded';
	if (url.searchParams.get('gh_jid')) return 'embedded';

	if (KNOWN_UNSUPPORTED.some((h) => host === h || host.endsWith(`.${h}`))) return 'unsupported';

	return 'unknown';
}
