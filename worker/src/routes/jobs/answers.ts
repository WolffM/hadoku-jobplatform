import type { D1Database } from '@cloudflare/workers-types';
import { createRoute, z } from '@hono/zod-openapi';
import {
	AnswerResponseSchema,
	AnswersResponseSchema,
	ErrorResponseSchema,
	SetAnswerSchema,
	UnansweredResponseSchema,
} from '../../schemas.js';
import { COMMON_QUESTIONS } from '../../commonQuestions.js';
import { questionKey } from '../../questionKey.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

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

const FORBIDDEN = {
	success: false as const,
	error: 'Forbidden',
	message: 'Authentication required',
};

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

	const answered = await db
		.prepare('SELECT question_key FROM application_answers WHERE user_id = ?')
		.bind(userId)
		.all<{ question_key: string }>();
	const known = new Set(answered.results.map((r) => r.question_key));

	// key -> the question as last seen, plus who is waiting on it
	const pending = new Map<
		string,
		{ question: string; companies: Set<string>; applications: number; blocking: number }
	>();

	for (const row of rows.results) {
		let unmatched: unknown;
		try {
			unmatched = (JSON.parse(row.evidence) as Record<string, unknown>).unmatched;
		} catch {
			// A hand-edited or truncated blob is skipped, not fatal: one bad row
			// must not hide every other question in the queue.
			continue;
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
			};
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
		});
	}

	return (
		[...pending.entries()]
			.map(([key, v]) => ({
				question_key: key,
				question: v.question,
				companies: [...v.companies].sort(),
				applications: v.applications,
				blocking: v.blocking,
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
			responses: {
				200: {
					description: 'Answers, most recently updated first',
					content: { 'application/json': { schema: AnswersResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);
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
			request: { body: { content: { 'application/json': { schema: SetAnswerSchema } } } },
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
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);
			const { question, answer } = c.req.valid('json');
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
			request: { params: z.object({ key: z.string() }) },
			responses: {
				200: {
					description: 'Deleted (or was already absent)',
					content: { 'application/json': { schema: AnswersResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);
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
			responses: {
				200: {
					description: 'The queue',
					content: { 'application/json': { schema: UnansweredResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);
			const questions = await unansweredQuestions(c.env.JOB_PLATFORM_DB, userId);
			return c.json({ success: true as const, data: { questions } }, 200);
		}
	);
}
