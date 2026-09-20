/**
 * Reading an ATS mail: what kind is it, and which employer is it about.
 *
 * Pure functions over subject + sender. No I/O, no database, no message bodies
 * — everything here is decided from the two fields that are stable across
 * employers, which is also the least we can look at to do the job.
 *
 * WHAT THE MEASUREMENTS SAID (live feed, 2026-09-19, 7 messages):
 *
 *   no-reply@ashbyhq.com            Thank You for Applying! Pinecone Has Received Your Application
 *   no-reply@us.greenhouse-mail.io  Security code for your application to Airtable
 *   login@us.greenhouse-jobs.com    Here's your MyGreenhouse security code
 *   no-reply@us.greenhouse-jobs.com Welcome to MyGreenhouse. Start your search.
 *
 * Two things follow, and both shape this module:
 *
 * 1. **Greenhouse has never sent a confirmation.** Every Greenhouse message is
 *    a security code or account mail. All 37 applications in this system are
 *    Greenhouse, so "waiting on a code" is our common case and "confirmed" is
 *    the rare one. A reconciler written around confirmations alone would find
 *    nothing and report it as silence.
 *
 * 2. **A brand name is not a sending domain.** `greenhouse.io` has never sent
 *    this mailbox anything; the real senders are `us.greenhouse-mail.io` and
 *    `us.greenhouse-jobs.com`. The first version of the upstream request
 *    guessed the former from the brand and would have matched 0% of our
 *    corpus — failing as silence, which is indistinguishable from the thing
 *    this detects. Nothing here may infer a domain from a name.
 */

/** What an ATS mail is telling us. */
export type MailKind = 'confirmation' | 'verification' | 'other';

export interface ParsedMail {
	kind: MailKind;
	/** The employer the mail is about, lowercased, or null if it names none. */
	company: string | null;
}

/**
 * Subjects that mean "we have your application".
 *
 * Wording varies per employer even on one ATS, so these match the phrases
 * rather than a whole subject.
 */
const CONFIRMATION_PATTERNS: RegExp[] = [
	/\bthank you for applying\b/i,
	/\bthanks for applying\b/i,
	/\bhas received your application\b/i,
	/\bapplication (?:was )?received\b/i,
	/\bwe received your application\b/i,
];

/**
 * Subjects that mean "a human must type a code before this goes anywhere".
 *
 * `is_submitted`'s counterpart in `hadoku_scrape/apply/_answers.py`, read from
 * the mail side instead of the page. A message matching this is proof the
 * application is NOT yet in — which is the opposite of what a mail from an
 * employer intuitively suggests, and the reason this is matched before
 * confirmations below.
 */
const VERIFICATION_PATTERNS: RegExp[] = [
	/\bsecurity code\b/i,
	/\bverification code\b/i,
	/\bconfirm (?:you'?re|you are) a human\b/i,
	/\byour .{0,20}code\b/i,
];

/**
 * Subjects that are an ATS talking about ITSELF, not about an application.
 *
 * "Welcome to MyGreenhouse. Start your search." is account onboarding for
 * Greenhouse's own job-seeker product. Treating it as an application event
 * would invent one against whichever employer happened to be nearby.
 */
const ACCOUNT_PATTERNS: RegExp[] = [
	/\bwelcome to my\w+/i,
	/\bstart your search\b/i,
	/\bcreate your (?:account|profile)\b/i,
	/\breset your password\b/i,
];

/**
 * The employer named in a subject.
 *
 * Only these shapes, because each was measured. Guessing more aggressively —
 * "the capitalised word" — turns "Start your search" into a company called
 * Start.
 */
// ORDER MATTERS: most-terminated first. A pattern anchored on `$` will happily
// swallow a trailing clause — "Your application to Acme Corp was received"
// yields "acme corp was received" if the end-anchored form is tried first. The
// test for that shape is what caught it.
const COMPANY_PATTERNS: RegExp[] = [
	// "Your application to Acme Corp was received"
	/\bapplication to\s+(.+?)\s+(?:was|has been|is)\b/i,
	// "Thank You for Applying! Pinecone Has Received Your Application"
	/^[^!]*!\s*(.+?)\s+has received your application/i,
	// "Security code for your application to Coinbase"
	/\byour application to\s+(.+?)\s*$/i,
	// "Thank you for applying to Pinecone"
	/\bfor applying to\s+(.+?)\s*$/i,
];

/** Trailing noise that is never part of a company name. */
const COMPANY_TRAILING = /[\s.!,;:–—-]+$/;

function cleanCompany(raw: string): string | null {
	const cleaned = raw.replace(COMPANY_TRAILING, '').trim();
	// A "company" longer than this is a sentence that happened to match.
	if (!cleaned || cleaned.length > 60) return null;
	return cleaned.toLowerCase();
}

/** The employer a subject names, or null when it names none. */
export function companyFromSubject(subject: string): string | null {
	for (const pattern of COMPANY_PATTERNS) {
		const hit = pattern.exec(subject);
		if (hit?.[1]) {
			const cleaned = cleanCompany(hit[1]);
			if (cleaned) return cleaned;
		}
	}
	return null;
}

/**
 * Classify one ATS mail.
 *
 * ORDER MATTERS. Account mail is excluded first, then verification, and only
 * then confirmation. A code mail's subject can contain "application" and would
 * otherwise read as a confirmation — which would record an application as
 * successfully received at the exact moment it is blocked, the single most
 * misleading answer available.
 */
export function parseMail(subject: string, fromDomain: string): ParsedMail {
	const company = companyFromSubject(subject);

	if (ACCOUNT_PATTERNS.some((p) => p.test(subject))) {
		return { kind: 'other', company: null };
	}
	if (VERIFICATION_PATTERNS.some((p) => p.test(subject))) {
		return { kind: 'verification', company };
	}
	if (CONFIRMATION_PATTERNS.some((p) => p.test(subject))) {
		return { kind: 'confirmation', company };
	}
	// Unrecognised wording from a granted ATS domain. 'other' rather than a
	// guess: the sender is in scope, so this is a shape worth noticing in
	// mail_unmatched, and inventing a kind for it would be the brand-name
	// mistake in another costume.
	void fromDomain;
	return { kind: 'other', company };
}

/**
 * Does this mail's company name refer to the same employer as a job row's?
 *
 * Both sides are messy in different ways — a job row says "coinbase", a subject
 * says "Coinbase", and either may carry "Inc" or "Technologies" — so this
 * compares on a reduced form rather than requiring equality.
 *
 * Substring in EITHER direction is deliberate and is safe here in a way it was
 * NOT safe for combobox options (see `option_consistent` in the scraper, where
 * "Male" matching "Female" was a real bug): there, the candidates were two
 * options of one question and a substring picked the wrong one. Here the
 * comparison is between an employer named in a subject and the employer on an
 * application we already hold, and the failure mode of a loose match is a
 * confirmation attached to the wrong company — which the date window and the
 * per-company scoping both constrain.
 */
const COMPANY_NOISE = /\b(inc|llc|ltd|corp|corporation|technologies|labs|the)\b/g;

export function normalizeCompany(name: string): string {
	return name
		.toLowerCase()
		.replace(COMPANY_NOISE, ' ')
		.replace(/[^a-z0-9]+/g, '')
		.trim();
}

export function companiesMatch(mailCompany: string, jobCompany: string): boolean {
	const a = normalizeCompany(mailCompany);
	const b = normalizeCompany(jobCompany);
	if (!a || !b) return false;
	return a === b || a.includes(b) || b.includes(a);
}
