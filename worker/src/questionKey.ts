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
