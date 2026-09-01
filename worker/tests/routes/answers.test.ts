/**
 * The unanswered-questions queue, and the answers that empty it.
 *
 * The queue is DERIVED from what the runner already reports in evidence, so
 * these tests seed applications the way the runner would and check what comes
 * back — rather than writing to a queue table that does not exist.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const BASE = '/jobplatform/api';
const OWNER = 'answer-owner';

interface Answer {
	question_key: string;
	question: string;
	answer: string;
	updated_at: string;
}
interface Unanswered {
	question_key: string;
	question: string;
	companies: string[];
	applications: number;
	blocking: number;
}

let h: Harness;

/**
 * Questions the runner actually met, as opposed to the common-question seed.
 * The seed rides in the same list on purpose — to the owner they are all just
 * things to answer — so tests about what a FILL reported have to separate them.
 */
const met = (qs: Unanswered[]) => qs.filter((q) => q.companies.length > 0);

function get<T>(path: string, userId = OWNER) {
	return h.json<{ success: boolean; data: T; message: string }>(`${BASE}${path}`, {
		method: 'GET',
		tier: 'friend',
		userId,
	});
}

function putAnswer(question: string, answer: string, userId = OWNER) {
	return h.json<{ success: boolean; data: { answer: Answer }; message: string }>(
		`${BASE}/application-answers`,
		{ method: 'PUT', tier: 'friend', userId, body: JSON.stringify({ question, answer }) }
	);
}

async function seedFill(
	jobId: string,
	company: string,
	unmatched: string[],
	status = 'needs_manual'
) {
	await seedJob(h.db, { id: jobId, company });
	await seedJobState(h.db, {
		job_id: jobId,
		user_id: OWNER,
		state: 'interested',
		variant_slug: 'v1',
	});
	const now = new Date().toISOString();
	await h.db
		.prepare(
			`INSERT INTO applications
			   (id, user_id, job_id, variant_slug, mode, status, evidence, created_at, updated_at)
			 VALUES (?, ?, ?, 'v1', 'review', ?, ?, ?, ?)`
		)
		.bind(`app-${jobId}`, OWNER, jobId, status, JSON.stringify({ unmatched, filled: [] }), now, now)
		.run();
}

before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});
beforeEach(async () => {
	await h.db.prepare('DELETE FROM applications').run();
	await h.db.prepare('DELETE FROM application_answers').run();
	await h.db.prepare('DELETE FROM job_states').run();
	await h.db.prepare('DELETE FROM jobs').run();
});

describe('GET /unanswered-questions', () => {
	it('reports nothing met when nothing has been filled', async () => {
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.deepEqual(met(body.data.questions), []);
	});

	it('surfaces what the runner could not answer', async () => {
		await seedFill('j1', 'Coinbase', ['Are you at least 18 years of age?']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.equal(met(body.data.questions).length, 1);
		assert.equal(met(body.data.questions)[0].question, 'Are you at least 18 years of age?');
		assert.deepEqual(met(body.data.questions)[0].companies, ['Coinbase']);
	});

	it('collapses one question asked by several employers', async () => {
		// The entire point of learning an answer once. Different wording of the
		// SAME question (a trailing required marker) must not split the row.
		await seedFill('j1', 'Coinbase', ['Are you at least 18 years of age?']);
		await seedFill('j2', 'Pinterest', ['Are you at least 18 years of age? *']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.equal(met(body.data.questions).length, 1);
		assert.equal(met(body.data.questions)[0].applications, 2);
		assert.deepEqual(met(body.data.questions)[0].companies, ['Coinbase', 'Pinterest']);
	});

	it('counts applications, not employers', async () => {
		// Two postings at ONE employer are two applications held up. Counting
		// distinct companies reported "1 application" next to "blocking 2" — the
		// same row disagreeing with itself, seen on the first real drain.
		await seedFill('j1', 'Coinbase', ['Are you at least 18 years of age?']);
		await seedFill('j2', 'Coinbase', ['Are you at least 18 years of age?']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions)[0];
		assert.equal(q.applications, 2);
		assert.equal(q.blocking, 2);
		assert.deepEqual(q.companies, ['Coinbase']);
	});

	it('ranks by what it is actually costing', async () => {
		await seedFill('j1', 'Acme', ['Cheap question'], 'filled');
		await seedFill('j2', 'Globex', ['Expensive question']);
		await seedFill('j3', 'Initech', ['Expensive question']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.equal(body.data.questions[0].question, 'Expensive question');
		assert.equal(body.data.questions[0].blocking, 2);
		assert.equal(met(body.data.questions)[1].blocking, 0, 'unanswered but not blocking');
	});

	it('drops a question once it has an answer', async () => {
		await seedFill('j1', 'Coinbase', ['Are you at least 18 years of age?']);
		await putAnswer('Are you at least 18 years of age?', 'Yes');
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.deepEqual(met(body.data.questions), []);
	});

	it('matches an answer to the question however the next board words it', async () => {
		await putAnswer('Preferred Pronouns', 'did not provide');
		await seedFill('j1', 'Acme', ['preferred pronouns *']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.deepEqual(met(body.data.questions), [], 'normalization must agree with the runner');
	});

	it('survives a corrupt evidence blob instead of hiding the whole queue', async () => {
		await seedFill('j1', 'Acme', ['Good question']);
		await h.db.prepare("UPDATE applications SET evidence = '{not json' WHERE job_id = 'j2'").run();
		await seedFill('j2', 'Globex', ['Another question']);
		await h.db.prepare("UPDATE applications SET evidence = '{not json' WHERE id = 'app-j2'").run();
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.equal(met(body.data.questions).length, 1);
		assert.equal(met(body.data.questions)[0].question, 'Good question');
	});

	it("does not leak another user's questions", async () => {
		await seedFill('j1', 'Coinbase', ['Secret question']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions', 'someone');
		assert.deepEqual(met(body.data.questions), []);
	});
});

describe('application answers', () => {
	it('saves and lists an answer', async () => {
		await putAnswer('Gender', 'Decline To Self Identify');
		const { body } = await get<{ answers: Answer[] }>('/application-answers');
		assert.equal(body.data.answers.length, 1);
		assert.equal(body.data.answers[0].answer, 'Decline To Self Identify');
		assert.equal(body.data.answers[0].question_key, 'gender');
	});

	it('replaces rather than duplicating when re-answered', async () => {
		await putAnswer('Gender', 'first');
		await putAnswer('gender *', 'second');
		const { body } = await get<{ answers: Answer[] }>('/application-answers');
		assert.equal(body.data.answers.length, 1);
		assert.equal(body.data.answers[0].answer, 'second');
	});

	it('accepts an empty answer, which means "leave it blank"', async () => {
		// Without this a question the owner wants skipped can never leave the
		// queue — there would be no way to say "nothing goes here".
		const { status } = await putAnswer('Website', '');
		assert.equal(status, 200);
		const { body } = await get<{ answers: Answer[] }>('/application-answers');
		assert.equal(body.data.answers[0].answer, '');
	});

	it('refuses a question with no matchable text', async () => {
		// "***" normalizes to "", which would match every blank question the
		// runner ever sees.
		const { status, body } = await putAnswer('***', 'Yes');
		assert.equal(status, 400);
		assert.match(body.message, /matchable/);
	});

	it('forgets an answer on request, putting the question back in the queue', async () => {
		await seedFill('j1', 'Coinbase', ['Are you at least 18 years of age?']);
		await putAnswer('Are you at least 18 years of age?', 'Yes');
		await h.json(`${BASE}/application-answers/are you at least 18 years of age`, {
			method: 'DELETE',
			tier: 'friend',
			userId: OWNER,
		});
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.equal(met(body.data.questions).length, 1);
	});

	it('keeps users apart', async () => {
		await putAnswer('Gender', 'mine');
		const { body } = await get<{ answers: Answer[] }>('/application-answers', 'someone');
		assert.deepEqual(body.data.answers, []);
	});

	it('403s anonymously', async () => {
		const res = await h.fetch(`${BASE}/application-answers`, { method: 'GET' });
		assert.equal(res.status, 403);
	});
});

describe('the common-question seed', () => {
	it('gives the owner something to answer before any fill has happened', async () => {
		// Otherwise the store could only be filled by first FAILING an
		// application, which is backwards when the questions are this predictable.
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.ok(body.data.questions.length > 0);
		assert.ok(body.data.questions.every((q) => q.companies.length === 0));
	});

	it('drops a seeded question once it is answered', async () => {
		const before = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const target = before.body.data.questions[0];
		await putAnswer(target.question, 'Some answer');
		const after = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.ok(!after.body.data.questions.some((q) => q.question_key === target.question_key));
	});

	it('never overwrites a question the runner actually met', async () => {
		// A seeded entry carries no company; a real one carries the employers
		// that asked. Losing that would hide what an answer is worth.
		await seedFill('j1', 'Coinbase', ['Veteran Status']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const veteran = body.data.questions.filter((q) => q.question_key === 'veteran status');
		assert.equal(veteran.length, 1, 'seed and reality must not both appear');
		assert.deepEqual(veteran[0].companies, ['Coinbase']);
	});
});
