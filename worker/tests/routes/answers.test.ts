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
interface Similar {
	question_key: string;
	question: string;
	answer: string;
	shared_terms: string[];
	only_in_pending: string[];
	only_in_answered: string[];
	polarity_differs: boolean;
	runner_would_match: boolean;
}
interface Unanswered {
	options: string[];
	question_key: string;
	question: string;
	companies: string[];
	applications: number;
	blocking: number;
	similar: Similar[];
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
	status = 'needs_manual',
	options: Record<string, string[]> = {}
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
		.bind(
			`app-${jobId}`,
			OWNER,
			jobId,
			status,
			JSON.stringify({ unmatched, filled: [], options }),
			now,
			now
		)
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

describe('question options', () => {
	/**
	 * An answer only lands if it matches the board's option text verbatim, so a
	 * question with choices must be answered by picking. Real Coinbase options
	 * captured 2026-09-01 include "No, I am not a current or former Government
	 * Official" and "Confirmed" — typing "No" or "Yes" does nothing, silently,
	 * and the question comes straight back looking unanswered.
	 */
	it('hands the form choices to whoever has to answer', async () => {
		await seedFill('j1', 'Coinbase', ['Are you a current government official?'], 'needs_manual', {
			'are you a current government official': [
				'No, I am not a current or former Government Official',
				'Yes, I am a current Government Official',
			],
		});
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions)[0];
		assert.equal(q.options.length, 2);
		assert.match(q.options[0], /^No, I am not/);
	});

	it('gives a SEEDED question the options a fill already learnt', async () => {
		// The one the owner reported. "Are you Hispanic/Latino?" is answered
		// from the canned set, so it never appears in `unmatched` — but a fill
		// still SAW it and learnt its options. Reading options only off pending
		// entries sent it to the dashboard as a free-text box for a
		// fixed-option EEO question.
		await seedFill('h1', 'Coinbase', ['Something else entirely'], 'needs_manual', {
			'are you hispanic latino': ['Yes', 'No', 'Decline To Self Identify'],
		});
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = body.data.questions.find((x) => x.question_key === 'are you hispanic latino');
		assert.ok(q, 'the seed is present');
		assert.equal(q.companies.length, 0, 'still a seed — no fill failed on it');
		assert.deepEqual(q.options, ['Yes', 'No', 'Decline To Self Identify']);
	});

	it('reports no options for a genuinely free-text question', async () => {
		await seedFill('j2', 'Acme', ['Why do you want to work here?']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.deepEqual(met(body.data.questions)[0].options, []);
	});

	it('keeps one wording rather than blending two employers', async () => {
		// Two boards asking "the same" question offer different option TEXT. A
		// merged list would be verbatim for neither, which is the one property
		// an option list has to have.
		await seedFill('j3', 'Coinbase', ['Do you require sponsorship?'], 'needs_manual', {
			'do you require sponsorship': ['Yes', 'No'],
		});
		await seedFill('j4', 'Globex', ['Do you require sponsorship?'], 'needs_manual', {
			'do you require sponsorship': ['Yes, I will need sponsorship', 'No, I will not'],
		});
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions).find((x) => x.question_key === 'do you require sponsorship');
		assert.equal(q?.options.length, 2);
		const blended =
			q!.options.includes('Yes') && q!.options.includes('Yes, I will need sponsorship');
		assert.equal(blended, false, 'one employer’s wording, not a mixture');
	});

	it('a seeded question claims nothing about what it accepts', async () => {
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const seeded = body.data.questions.filter((q) => q.companies.length === 0);
		assert.ok(seeded.length > 0);
		assert.ok(seeded.every((q) => q.options.length === 0));
	});

	it('survives options that are not a string array', async () => {
		await seedFill('j5', 'Acme', ['Odd question'], 'needs_manual', {
			'odd question': [1, null, 'Fine'] as unknown as string[],
		});
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions).find((x) => x.question_key === 'odd question');
		assert.deepEqual(q?.options, ['Fine']);
	});
});

/**
 * Flagging questions that look like ones already answered.
 *
 * The fixtures are the owner's REAL clusters, taken from production on
 * 2026-09-09: four work-authorization questions and three sponsorship ones,
 * every pair of which the runner's matcher refuses to collapse. That refusal is
 * the point — these tests exist to prove the dashboard surfaces the difference
 * rather than papering over it.
 */
describe('duplicate flagging on the unanswered queue', () => {
	const US_AUTH = 'Are you legally authorized to work in the United States?';
	const JOB_AUTH = 'Are you legally authorized to work in the country where the job is located?';

	it('flags a look-alike and names the words that differ', async () => {
		await putAnswer(US_AUTH, 'Yes');
		await seedFill('j-dup', 'Pinterest', [JOB_AUTH]);

		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions).find((x) => x.question === JOB_AUTH);
		assert.ok(q, 'the pending question is still surfaced in full');

		const hit = q.similar.find((s) => s.question === US_AUTH);
		assert.ok(hit, 'the answered look-alike is flagged');
		assert.equal(hit.answer, 'Yes', 'and carries what was said last time');
		assert.deepEqual(hit.shared_terms, ['authorized', 'legally', 'work']);
		// The difference is the whole question: one asks about the US, the other
		// about wherever the job happens to be.
		assert.ok(hit.only_in_answered.includes('united'));
		assert.ok(hit.only_in_pending.includes('located'));
		assert.equal(
			hit.runner_would_match,
			false,
			'the runner would REFUSE this transfer — the flag must say so, not imply a match'
		);
	});

	it('never applies the flagged answer by itself', async () => {
		await putAnswer(US_AUTH, 'Yes');
		await seedFill('j-noauto', 'Pinterest', [JOB_AUTH]);

		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.ok(
			met(body.data.questions).some((q) => q.question === JOB_AUTH),
			'a flagged question stays UNANSWERED until the owner saves something'
		);
		const stored = await h.db
			.prepare('SELECT COUNT(*) AS n FROM application_answers WHERE user_id = ?')
			.bind(OWNER)
			.first<{ n: number }>();
		assert.equal(stored?.n, 1, 'and nothing was written on its behalf');
	});

	it('marks a polarity flip, which is the dangerous look-alike', async () => {
		await putAnswer('Will you require sponsorship for employment visa status?', 'No');
		await seedFill('j-neg', 'Coinbase', [
			'Are you able to work without sponsorship for employment visa status?',
		]);

		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions)[0];
		const hit = q.similar[0];
		assert.ok(hit, 'still flagged — a human should see it');
		assert.equal(
			hit.polarity_differs,
			true,
			'"without sponsorship" reverses the question; copying "No" would state the opposite'
		);
	});

	it('reports runner_would_match when the stored wording really does cover it', async () => {
		// form ⊆ stored: every meaningful word of the short question is in the
		// long one, so the runner transfers it unaided.
		await putAnswer(
			'Will you now or in the future require employer sponsorship or other ' +
				'assistance to obtain, extend, or maintain authorization to work?',
			'No'
		);
		await seedFill('j-sub', 'Coinbase', ['Will you require sponsorship?']);

		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions)[0];
		assert.equal(q.similar[0]?.runner_would_match, true);
		assert.deepEqual(q.similar[0].only_in_pending, [], 'nothing in the form the stored one lacks');
	});

	it('stays quiet on questions that merely share a generic frame', async () => {
		await putAnswer('Veteran Status', 'I am not a protected veteran');
		await seedFill('j-far', 'Pinterest', ['What U.S State do you currently reside in?']);

		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		const q = met(body.data.questions)[0];
		assert.deepEqual(q.similar, [], 'two unrelated questions are not a duplicate pair');
	});

	it('every pending question carries the field, flagged or not', async () => {
		await seedFill('j-none', 'Pinterest', ['Website']);
		const { body } = await get<{ questions: Unanswered[] }>('/unanswered-questions');
		assert.ok(body.data.questions.every((q) => Array.isArray(q.similar)));
	});
});
