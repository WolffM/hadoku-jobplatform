/**
 * Which questions are the SAME personal fact, asked in different words.
 *
 * The runner's matcher deliberately refuses to carry an answer across wordings,
 * and for good reason: "Are you legally entitled to work in Canada?" shares
 * nearly every word with "Are you legally authorized to work in the United
 * States?", and copying "Yes" across is a false statement on an application.
 * Overlap scoring did exactly that, four times, before the refusal existed.
 *
 * The cost is that the owner re-answers the same fact in every employer's
 * phrasing: on 2026-10-01 sponsorship alone came up nine times. This module is
 * the narrow middle ground. It names a small set of facts that do NOT vary by
 * employer, with explicit rules for what belongs to each, so the dashboard can
 * show one family once — every wording listed, the owner's previous answer
 * pre-filled — and the owner confirms them together. Nothing is answered for
 * them; the grouping only saves the typing.
 *
 * Precision over recall, throughout. A question that misses a family costs the
 * owner one extra answer. A question wrongly let IN costs a false statement.
 * Every rule below was derived from the 125 real questions the owner had seen
 * by 2026-10-01, and `tests/questionFamily.test.ts` pins them.
 */

import { questionKey, questionNegated, questionTerms } from './questionKey.js';

export interface QuestionFamily {
	id: string;
	label: string;
}

interface FamilyRule {
	id: string;
	label: string;
	/** Tested against the question's HEAD — see `head()`. */
	match: (head: string) => boolean;
	/**
	 * Whether the answer flips with the country or the phrasing. True for the
	 * legal-status facts, where "Canada" or "without sponsorship" changes the
	 * right answer; false for demographics, which do not depend on either.
	 */
	sensitive: boolean;
}

/**
 * A country other than the US named in the question. For a legal-status fact
 * that makes it a different question entirely — the owner's US answer says
 * nothing about Canada or Ireland.
 */
const FOREIGN =
	/\b(canada|canadian|quebec|ireland|irish|uk|united kingdom|britain|england|scotland|germany|france|india|australia|mexico|brazil|japan|singapore|netherlands|spain|israel|poland|china|emea|europe|apac|latam)\b/;

/**
 * A legal agreement. Never grouped: each is a specific employer's terms
 * (arbitration, privacy, data processing) and deserves its own reading, even
 * where the owner's answer would be the same every time.
 */
const LEGAL =
	/\b(agree|agreement|certify|consent|acknowledge|arbitrat\w*|privacy|terms of service|confirm receipt|attest|personal data)\b/;

/**
 * A follow-up that only means something given an earlier answer —
 * "If you do require sponsorship, please list the type". It shares the
 * family's words and none of its meaning.
 */
const CONDITIONAL =
	/^if\b|\bif you (do|did|selected|answered|chose|said|have|are|were)\b|\bplease (list|share|explain|describe|specify|provide)\b/;

/**
 * ORDER MATTERS: first match wins. Sponsorship precedes work authorization
 * because "require sponsorship to maintain your work authorization" is about
 * sponsorship, and race precedes Hispanic/Latino for the same reason.
 */
const RULES: FamilyRule[] = [
	{
		id: 'sponsorship',
		label: 'Visa sponsorship',
		match: (h) =>
			/\bsponsor/.test(h) || (/\b(visa|immigration)\b/.test(h) && /\b(require|need)\b/.test(h)),
		sensitive: true,
	},
	{
		id: 'work_authorization',
		label: 'Authorized to work',
		match: (h) => /\b(authori[sz]ed|eligible|entitled|right)\b/.test(h) && /\bto work\b/.test(h),
		sensitive: true,
	},
	{
		id: 'race_ethnicity',
		label: 'Race / ethnicity',
		match: (h) => /\b(race|racial|ethnicity|ethnic)\b/.test(h),
		sensitive: false,
	},
	{
		id: 'hispanic_latino',
		label: 'Hispanic / Latino',
		match: (h) => /\b(hispanic|latino|latina|latinx)\b/.test(h),
		sensitive: false,
	},
	{
		id: 'veteran',
		label: 'Veteran status',
		match: (h) => /\b(veteran|military|armed forces)\b/.test(h),
		sensitive: false,
	},
	{ id: 'disability', label: 'Disability', match: (h) => /\bdisabilit/.test(h), sensitive: false },
	{ id: 'lgbtq', label: 'LGBTQ+', match: (h) => /\blgbt/.test(h), sensitive: false },
	{
		id: 'current_employer',
		label: 'Current employer',
		// "current", not "currently": "Are you currently employed by an Aledade
		// Partner Practice?" is a different question with a different answer.
		//
		// ADJACENT words, not "current … company" anywhere. The loose form put
		// "Are you a current government official or … a company …" in this
		// family, and its answer — "No, I am not a current or former Government
		// Official" — would have been offered for Most Recent Employer.
		match: (h) => /\b(current|most recent)( most recent)? (employer|company)\b/.test(h),
		sensitive: false,
	},
	{
		id: 'current_title',
		label: 'Current job title',
		match: (h) => /\b(current|most recent)( most recent)? (job )?title\b/.test(h),
		sensitive: false,
	},
	{
		id: 'state_of_residence',
		label: 'State you live in',
		// Not "plan": "the state you plan to be located in" asks about the
		// future, and may well differ.
		match: (h) =>
			/\bstate\b/.test(h) && /\b(reside|live|currently)\b/.test(h) && !/\bplan\b/.test(h),
		sensitive: false,
	},
	{
		id: 'postal_code',
		label: 'ZIP / postal code',
		match: (h) => /\b(zip|postal)\b/.test(h),
		sensitive: false,
	},
	{
		id: 'current_city',
		label: 'Where you live',
		match: (h) =>
			(/\b(current|currently)\b/.test(h) && /\blocat/.test(h)) || /\blocation city\b/.test(h),
		sensitive: false,
	},
	{
		id: 'how_heard',
		label: 'How you heard about the role',
		match: (h) =>
			/\bhow did you (first )?(hear|learn|find)\b/.test(h) ||
			/\bwhere (have|did) you (hear|heard|learn|learned)\b/.test(h),
		sensitive: false,
	},
	{
		id: 'worked_here_before',
		label: 'Worked at this company before',
		// A fact about EACH employer, so the dashboard lists every company and
		// the owner unticks any they did work for. Grouped because the answer is
		// "no" for every employer they never worked at, which is nearly all.
		match: (h) =>
			(/\b(previously|formerly|ever|before)\b/.test(h) && /\b(employed|worked)\b/.test(h)) ||
			/\bformer\b.*\bemployee\b/.test(h),
		sensitive: false,
	},
	{
		id: 'website',
		label: 'Personal website',
		match: (h) => /^websites?\b/.test(h),
		sensitive: false,
	},
	{ id: 'github', label: 'GitHub profile', match: (h) => /\bgithub\b/.test(h), sensitive: false },
	{
		id: 'pronouns',
		label: 'Pronouns',
		// Not a question that also asks for a name — Samsara's "share your
		// preferred name and pronouns" wants both in one box, and a bare
		// "He/Him" would answer half of it.
		match: (h) => /\bpronouns?\b/.test(h) && !/\bname\b/.test(h),
		sensitive: false,
	},
];

/**
 * The question itself, without what follows it.
 *
 * Boards append boilerplate after the question mark — "This includes, but is
 * not limited to, H-1B visas…", "Please note we are unable to hire candidates
 * based in Quebec". Read whole, the first trips the negation check and the
 * second the foreign-country check, though neither changes what is asked.
 */
function head(question: string): string {
	return questionKey(question.split('?')[0] ?? '') || questionKey(question);
}

/** The family a question belongs to, or null when it should stand alone. */
export function questionFamily(question: string): QuestionFamily | null {
	const full = questionKey(question);
	if (!full || LEGAL.test(full) || CONDITIONAL.test(full)) return null;
	const h = head(question);
	for (const rule of RULES) {
		if (!rule.match(h)) continue;
		if (rule.sensitive && (FOREIGN.test(h) || questionNegated(questionTerms(h)))) return null;
		return { id: rule.id, label: rule.label };
	}
	return null;
}

/**
 * The option on THIS board that says what `answer` says, or null when no
 * option clearly does.
 *
 * An answer must match a board's option text verbatim to land, and boards word
 * the same choice differently. Three ways to be sure, in order; anything less
 * is left for the owner to pick, because a confident wrong pick here is the
 * Male-entered-as-Female failure all over again.
 *
 * 1. The same text once normalised — which already expands contractions, so
 *    "No, I do not have a disability" IS "No, I don't have a disability".
 * 2. A plain yes or no, and exactly one option leading with that word.
 * 3. One option containing the answer as whole words, or vice versa — and
 *    only one. "LinkedIn" against "LinkedIn (Job Posting)" and "LinkedIn
 *    (Datadog Page)" is ambiguous and returns null.
 *
 * A question with no options takes the answer as typed.
 */
export function matchOption(answer: string, options: string[]): string | null {
	const a = answer.trim();
	if (!a) return null;
	if (options.length === 0) return a;

	const na = questionKey(a);
	const exact = options.filter((o) => questionKey(o) === na);
	if (exact.length === 1) return exact[0] ?? null;

	const lead = na.split(' ')[0];
	if (lead === 'yes' || lead === 'no') {
		const same = options.filter((o) => questionKey(o).split(' ')[0] === lead);
		return same.length === 1 ? (same[0] ?? null) : null;
	}

	const within = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `);
	const hits = options.filter((o) => {
		const no = questionKey(o);
		return within(no, na) || within(na, no);
	});
	return hits.length === 1 ? (hits[0] ?? null) : null;
}
