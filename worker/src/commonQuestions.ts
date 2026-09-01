/**
 * The questions worth answering before a board ever asks them.
 *
 * MEASURED, not guessed: sampled from 26 live Greenhouse application forms on
 * 2026-09-01 by reading every question label and counting how many boards asked
 * each. The head of that distribution is short and steep, which is what makes
 * seeding worth doing — a handful of answers covers most forms.
 *
 * Identity fields the runner already fills from the profile (name, email,
 * phone, résumé, current company) are excluded; nobody needs to answer those
 * twice.
 *
 * Notes that would once have been rendered as UI copy live here instead:
 *
 *  - "Location (City)" wants a bare city. A full "City, State, Country" is a
 *    different answer, and this is the field that actually stopped a real
 *    Coinbase fill.
 *  - "Preferred First Name" is never inferred from a legal name.
 *  - The two work-authorization entries are genuinely different questions.
 *    Matching refuses to read "the country where the job is located" as "the
 *    United States", so both need their own answer.
 *  - "Agreement to Arbitrate" is a binding legal agreement. Storing a standing
 *    yes applies it to every future application at that employer.
 *
 * These are observations with a date on them, not constants. Re-sample if the
 * shape starts looking wrong.
 */
export interface CommonQuestion {
	question: string;
	/** How many of the sampled boards asked it. */
	seenOn: number;
}

export const SAMPLE_SIZE = 26;

export const COMMON_QUESTIONS: CommonQuestion[] = [
	{ question: 'Veteran Status', seenOn: 15 },
	{ question: 'Disability Status', seenOn: 13 },
	{ question: 'Are you Hispanic/Latino?', seenOn: 13 },
	{ question: 'Location (City)', seenOn: 12 },
	{ question: 'Preferred First Name', seenOn: 11 },
	{ question: 'How did you hear about this job?', seenOn: 6 },
	{ question: 'Are you legally authorized to work in the United States?', seenOn: 3 },
	{
		question: 'Are you legally authorized to work in the country where the job is located?',
		seenOn: 2,
	},
	{
		question:
			'Will you now or in the future require company sponsorship to retain or extend your work authorization?',
		seenOn: 2,
	},
	{ question: 'I identify my gender as', seenOn: 2 },
	{ question: 'Are you at least 18 years of age?', seenOn: 1 },
	{ question: 'Agreement to Arbitrate', seenOn: 1 },
];
