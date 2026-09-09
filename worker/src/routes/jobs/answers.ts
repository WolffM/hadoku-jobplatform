import type { D1Database } from '@cloudflare/workers-types';
import { createRoute, z } from '@hono/zod-openapi';
import {
	AnswerResponseSchema,
	AnswersResponseSchema,
	ErrorResponseSchema,
	IdentityErrorResponseSchema,
	SetAnswerSchema,
	UnansweredResponseSchema,
} from '../../schemas.js';
import { COMMON_QUESTIONS } from '../../commonQuestions.js';
import { questionKey, questionNegated, questionTerms } from '../../questionKey.js';
import {
	effectiveUserId,
	gateAuthed,
	isEffectiveUserError,
	type JobsApp,
	ownerNameQuery,
} from './shared.js';

/**
 * Standing answers, and the queue of questions still missing one.
 *
 * The runner can only answer a question it has seen before, and every fill
 * already reports the ones it could not (`unmatched`, inside the application's
 * evidence blob). That report used to dead-end in a CLI listing, so the same
 * question blocked application after application until someone hand-edited a
 * file on the runner's machine.
 *
 * The queue is DERIVED from evidence rather than written to a table of its own.
 * The runner already posts what it could not answer on every fill, so a second
 * write path would be a second thing to keep in step — and one that could
 * disagree with the evidence the owner is looking at.
 */

interface AnswerRow {
	question_key: string;
	question: string;
	answer: string;
	updated_at: string;
}

// The 403 for an unauthenticated caller now comes from `effectiveUserId`, which
// every handler in this file routes through — so the local copy is gone rather
// than left as a second place the same message could drift.

/**
 * Answered questions that LOOK like the same question as `pendingKey`.
 *
 * Explicitly NOT a suggestion, and the distinction is the whole design. The
 * runner's matcher (`_subsumes` in `hadoku_scrape/apply/_answers.py`) refuses to
 * transfer an answer unless every meaningful word of the form's question appears
 * in the stored one, because the words that DIFFER are usually the entire
 * question: "authorized to work in the United States" and "...in Canada" share
 * their whole generic frame and mean opposite things. Four real false statements
 * about legal work authorization came out of overlap scoring before that rule
 * existed.
 *
 * So this does not pick, pre-fill or rank-by-confidence. It hands back the
 * related questions WITH THE WORDS THAT DIFFER called out, and a human decides.
 * A near-match presented as an answer gets rubber-stamped; a near-match
 * presented as "these two differ by 'united states' vs 'the country where the
 * job is located'" gets read.
 *
 * Looser than `_subsumes` on purpose — it surfaces candidates the runner would
 * refuse, which are exactly the ones worth a human's eye. That is only safe
 * because nothing here is applied without the owner saving it.
 */
interface SimilarAnswer {
	question_key: string;
	question: string;
	answer: string;
	/** Meaningful words the two share. */
	shared_terms: string[];
	/** In the UNANSWERED question only — what this one asks that the other did not. */
	only_in_pending: string[];
	/** In the ANSWERED question only — what that one was scoped to. */
	only_in_answered: string[];
	/**
	 * One carries a negation and the other does not, so a transferred answer
	 * would state the opposite. The loudest thing on the row when true.
	 */
	polarity_differs: boolean;
	/** True when the runner WOULD have transferred this itself (form ⊆ stored). */
	runner_would_match: boolean;
}

// Below this many shared meaningful words, two questions are not plausibly the
// same question and the row is noise. Two is low deliberately: the owner asked
// to see everything that looks like a duplicate and judge it, so the cost of a
// weak candidate is a glance, while the cost of hiding one is retyping.
const MIN_SHARED_TERMS = 2;
const MAX_SIMILAR = 4;

function findSimilar(
	pendingKey: string,
	answered: { question_key: string; question: string; answer: string }[]
): SimilarAnswer[] {
	const pendingTerms = questionTerms(pendingKey);
	if (pendingTerms.size === 0) return [];
	const pendingNeg = questionNegated(pendingTerms);

	const scored: (SimilarAnswer & { score: number })[] = [];
	for (const a of answered) {
		const terms = questionTerms(a.question_key);
		if (terms.size === 0) continue;
		const shared = [...pendingTerms].filter((t) => terms.has(t));
		if (shared.length < MIN_SHARED_TERMS) continue;
		const onlyPending = [...pendingTerms].filter((t) => !terms.has(t));
		const onlyAnswered = [...terms].filter((t) => !pendingTerms.has(t));
		const answeredNeg = questionNegated(terms);
		scored.push({
			question_key: a.question_key,
			question: a.question,
			answer: a.answer,
			shared_terms: shared.sort(),
			only_in_pending: onlyPending.sort(),
			only_in_answered: onlyAnswered.sort(),
			polarity_differs: pendingNeg !== answeredNeg,
			// The runner's own rule, reported rather than acted on: every
			// meaningful word of the pending question is already in the stored
			// one, and polarity agrees.
			runner_would_match:
				pendingTerms.size >= 2 && onlyPending.length === 0 && pendingNeg === answeredNeg,
			// Jaccard: rewards overlap but penalises each side's leftovers, so a
			// short generic question does not top the list against everything.
			score: shared.length / (pendingTerms.size + terms.size - shared.length),
		});
	}
	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_SIMILAR)
		.map(({ score: _score, ...rest }) => rest);
}

/** Every question this user has been unable to answer, with what it blocked. */
async function unansweredQuestions(db: D1Database, userId: string) {
	const rows = await db
		.prepare(
			`SELECT a.evidence, a.status, j.company
			 FROM applications a
			 JOIN jobs j ON j.id = a.job_id
			 WHERE a.user_id = ? AND a.evidence IS NOT NULL`
		)
		.bind(userId)
		.all<{ evidence: string; status: string; company: string }>();

	// The question TEXT and the answer come back too, because a flagged duplicate
	// has to show the owner what they said last time and to which wording.
	const answered = await db
		.prepare('SELECT question_key, question, answer FROM application_answers WHERE user_id = ?')
		.bind(userId)
		.all<{ question_key: string; question: string; answer: string }>();
	const known = new Set(answered.results.map((r) => r.question_key));

	/**
	 * Every option list this user's fills have ever seen, keyed by question.
	 *
	 * Separate from `pending` because the two are populated by different rules:
	 * a question enters `pending` only when a fill could not ANSWER it, while
	 * its options are learnt whenever a fill SEES it. Reading options straight
	 * off the pending entry meant an answered question — "Are you
	 * Hispanic/Latino?", answered from the canned set and asked as a picker on
	 * nearly every board — contributed its options to nothing, and reached the
	 * dashboard as a free-text box for a fixed-option question.
	 *
	 * First sighting wins: two employers wording one question differently offer
	 * different option TEXT, and a blend is verbatim for neither.
	 */
	const learnedOptions = new Map<string, string[]>();

	// key -> the question as last seen, plus who is waiting on it
	const pending = new Map<
		string,
		{
			question: string;
			companies: Set<string>;
			applications: number;
			blocking: number;
			options: string[];
		}
	>();

	for (const row of rows.results) {
		let unmatched: unknown;
		let optionsByKey: Record<string, unknown> = {};
		try {
			const parsedEvidence = JSON.parse(row.evidence) as Record<string, unknown>;
			unmatched = parsedEvidence.unmatched;
			const opts = parsedEvidence.options;
			if (typeof opts === 'object' && opts !== null && !Array.isArray(opts)) {
				optionsByKey = opts as Record<string, unknown>;
			}
		} catch {
			// A hand-edited or truncated blob is skipped, not fatal: one bad row
			// must not hide every other question in the queue.
			continue;
		}
		for (const [key, seen] of Object.entries(optionsByKey)) {
			if (learnedOptions.has(key) || !Array.isArray(seen)) continue;
			const clean = seen.filter((o): o is string => typeof o === 'string' && !!o);
			if (clean.length) learnedOptions.set(key, clean);
		}

		if (!Array.isArray(unmatched)) continue;
		for (const raw of unmatched) {
			if (typeof raw !== 'string' || !raw.trim()) continue;
			const key = questionKey(raw);
			if (!key || known.has(key)) continue;
			const entry = pending.get(key) ?? {
				question: raw.trim(),
				companies: new Set<string>(),
				applications: 0,
				blocking: 0,
				options: [] as string[],
			};
			// An answer must match the board's option text verbatim to land, so
			// these are not a hint — they are the only answers that work.
			if (!entry.options.length) entry.options = learnedOptions.get(key) ?? [];
			entry.companies.add(row.company);
			// Per APPLICATION, not per company. Two postings at one employer are
			// two applications held up; counting distinct companies reported
			// "1 application" beside "blocking 2" — the same row disagreeing with
			// itself, which is exactly what the first real drain showed.
			entry.applications += 1;
			// `needs_manual` is the status that actually costs an application; a
			// question that merely went unanswered on an otherwise-fine fill is
			// worth surfacing but is not holding anything up.
			if (row.status === 'needs_manual') entry.blocking += 1;
			pending.set(key, entry);
		}
	}

	// Seed with questions boards commonly ask, so the store can be filled before
	// an application has to fail to reveal them. Suggestions only: any already
	// answered are dropped, exactly like a question the runner really met, and
	// one the runner DID meet keeps its real company list rather than being
	// overwritten by the seed.
	for (const { question } of COMMON_QUESTIONS) {
		const key = questionKey(question);
		if (!key || known.has(key) || pending.has(key)) continue;
		pending.set(key, {
			question,
			companies: new Set<string>(),
			applications: 0,
			blocking: 0,
			// A seed carries no company, but it may still have options: a fill
			// that ANSWERED this question still learnt what it accepts. That is
			// the whole reason `learnedOptions` is built separately.
			options: learnedOptions.get(key) ?? [],
		});
	}

	return (
		[...pending.entries()]
			.map(([key, v]) => ({
				question_key: key,
				question: v.question,
				companies: [...v.companies].sort(),
				applications: v.applications,
				options: v.options,
				blocking: v.blocking,
				// Every pending question is returned whether or not it looks like a
				// duplicate — the owner asked to see them all. This only annotates.
				similar: findSimilar(key, answered.results),
			}))
			// Most blocking first: the queue is a work list, so what is costing the
			// most applications should be answered first.
			.sort((a, b) => b.blocking - a.blocking || b.applications - a.applications)
	);
}

export function registerAnswerRoutes(app: JobsApp): void {
	app.get('/application-answers', gateAuthed);
	app.put('/application-answers', gateAuthed);
	app.delete('/application-answers/:key', gateAuthed);
	app.get('/unanswered-questions', gateAuthed);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/application-answers',
			tags: ['Answers'],
			summary: "The caller's standing answers to application questions",
			request: {
				query: ownerNameQuery,
			},
			responses: {
				200: {
					description: 'Answers, most recently updated first',
					content: { 'application/json': { schema: AnswersResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'No such owner name',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				409: {
					description: 'That owner name has never signed in',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				503: {
					description: 'Identity could not be resolved right now — retry',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const { ownerName } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const userId = who.userId;
			const rows = await c.env.JOB_PLATFORM_DB.prepare(
				`SELECT question_key, question, answer, updated_at
				 FROM application_answers WHERE user_id = ? ORDER BY updated_at DESC`
			)
				.bind(userId)
				.all<AnswerRow>();
			return c.json({ success: true as const, data: { answers: rows.results } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'put',
			path: '/application-answers',
			tags: ['Answers'],
			summary: 'Save (or replace) the answer to one question',
			request: {
				query: ownerNameQuery,
				body: { content: { 'application/json': { schema: SetAnswerSchema } } },
			},
			responses: {
				200: {
					description: 'Saved',
					content: { 'application/json': { schema: AnswerResponseSchema } },
				},
				400: {
					description: 'Empty question',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'No such owner name',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				409: {
					description: 'That owner name has never signed in',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				503: {
					description: 'Identity could not be resolved right now — retry',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const { question, answer, ownerName } = c.req.valid('json');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const userId = who.userId;
			const key = questionKey(question);
			if (!key) {
				// A question of nothing but punctuation normalizes away entirely,
				// and would store an answer under an empty key that matches every
				// blank question the runner ever sees.
				return c.json(
					{
						success: false as const,
						error: 'Bad request',
						message: 'That question has no matchable text',
					},
					400
				);
			}
			const now = new Date().toISOString();
			await c.env.JOB_PLATFORM_DB.prepare(
				`INSERT INTO application_answers
				   (user_id, question_key, question, answer, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (user_id, question_key) DO UPDATE SET
				   question = excluded.question,
				   answer = excluded.answer,
				   updated_at = excluded.updated_at`
			)
				.bind(userId, key, question.trim(), answer, now, now)
				.run();
			return c.json(
				{
					success: true as const,
					data: {
						answer: {
							question_key: key,
							question: question.trim(),
							answer,
							updated_at: now,
						},
					},
				},
				200
			);
		}
	);

	app.openapi(
		createRoute({
			method: 'delete',
			path: '/application-answers/{key}',
			tags: ['Answers'],
			summary: 'Forget one standing answer',
			request: {
				params: z.object({ key: z.string() }),
				// No body on a DELETE, so the query string is the only way to name
				// an owner here — unlike the PUT, which reads either and prefers
				// the body.
				query: ownerNameQuery,
			},
			responses: {
				200: {
					description: 'Deleted (or was already absent)',
					content: { 'application/json': { schema: AnswersResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'No such owner name',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				409: {
					description: 'That owner name has never signed in',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				503: {
					description: 'Identity could not be resolved right now — retry',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const { ownerName } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const userId = who.userId;
			const { key } = c.req.valid('param');
			const db = c.env.JOB_PLATFORM_DB;
			await db
				.prepare('DELETE FROM application_answers WHERE user_id = ? AND question_key = ?')
				.bind(userId, key)
				.run();
			const rows = await db
				.prepare(
					`SELECT question_key, question, answer, updated_at
					 FROM application_answers WHERE user_id = ? ORDER BY updated_at DESC`
				)
				.bind(userId)
				.all<AnswerRow>();
			return c.json({ success: true as const, data: { answers: rows.results } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/unanswered-questions',
			tags: ['Answers'],
			summary: 'Questions the runner could not answer, most costly first',
			request: {
				query: ownerNameQuery,
			},
			responses: {
				200: {
					description: 'The queue',
					content: { 'application/json': { schema: UnansweredResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'No such owner name',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				409: {
					description: 'That owner name has never signed in',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				503: {
					description: 'Identity could not be resolved right now — retry',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const { ownerName } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const questions = await unansweredQuestions(c.env.JOB_PLATFORM_DB, who.userId);
			return c.json({ success: true as const, data: { questions } }, 200);
		}
	);
}
