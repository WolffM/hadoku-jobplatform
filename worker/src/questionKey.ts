/**
 * Reducing a form question to the key an answer is stored against.
 *
 * MIRRORS `hadoku_scrape/apply/_answers.py::normalize`, which is the source of
 * truth — it is what the runner matches with when it fills a form. If the two
 * drift, the site will happily save an answer the runner never finds, and the
 * question will keep coming back to the queue looking unanswered.
 *
 * The contraction expansion is not decoration: stripping punctuation turns
 * "don't" into "don t" and loses the negation entirely, and polarity decides
 * what a question means.
 */
export function questionKey(text: string): string {
	return text
		.replace(/\*/g, ' ')
		.toLowerCase()
		.replace(/n't\b/g, ' not ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * Words that carry no signal about WHICH question this is.
 *
 * MIRRORS `_STOPWORDS` in `hadoku_scrape/apply/_answers.py`, extracted from it
 * rather than retyped. It matters that the two agree: this list decides what
 * counts as a MEANINGFUL word, and the whole point of the duplicate flagging
 * below is to show the owner the same distinguishing words the runner's matcher
 * would refuse on. A list that drifts would highlight a difference the runner
 * does not see, or hide one it does.
 */
const STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'any',
	'are',
	'as',
	'at',
	'be',
	'by',
	'do',
	'does',
	'e',
	'etc',
	'for',
	'from',
	'g',
	'have',
	'i',
	'ie',
	'if',
	'in',
	'is',
	'it',
	'me',
	'my',
	'of',
	'on',
	'or',
	'our',
	'so',
	'that',
	'the',
	'their',
	'there',
	'they',
	'this',
	'to',
	'us',
	'we',
	'what',
	'when',
	'which',
	'will',
	'with',
	'would',
	'you',
	'your',
]);

/**
 * Words that reverse a question. Deliberately NOT stopwords — mirrors
 * `_NEGATIONS`. Dropping them made "will you require sponsorship" and "will you
 * NOT require sponsorship" the same key, and answering the second with the
 * first's answer is a misstatement rather than a near miss.
 */
const NEGATIONS = new Set(['cannot', 'neither', 'never', 'no', 'nor', 'not', 'without']);

/** The meaningful words of a question key. Mirrors `_tokens`. */
export function questionTerms(key: string): Set<string> {
	return new Set(key.split(' ').filter((w) => w && !STOPWORDS.has(w)));
}

/** Does this question carry a polarity-reversing word? Mirrors `_negated`. */
export function questionNegated(terms: Set<string>): boolean {
	for (const t of terms) if (NEGATIONS.has(t)) return true;
	return false;
}
