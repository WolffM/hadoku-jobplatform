/**
 * The approve-to-apply queue (issue #15).
 *
 * The behaviours that matter: applying demands a minted packet (409 without),
 * re-apply re-queues cleanly, the queue is strictly per-user, the runner's
 * status endpoint keeps evidence sticky while error tracks each transition,
 * and approve only fires at the review-mode pause point ('filled').
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

interface Application {
	id: string;
	job_id: string;
	variant_slug: string;
	mode: string;
	status: string;
	error: string | null;
	evidence: Record<string, unknown> | null;
	approved_fingerprint: string | null;
	created_at: string;
	updated_at: string;
}

interface ApplicationBody {
	success: boolean;
	data: { application: Application };
}

interface ApplicationsBody {
	success: boolean;
	data: {
		applications: Array<Application & { title: string; company: string; location: string }>;
	};
}

interface ErrorBody {
	success: boolean;
	error: string;
	message: string;
}

let h: Harness;

const OWNER = 'queue-owner';

function apply(
	jobId: string,
	opts: {
		userId?: string;
		mode?: 'review' | 'auto';
		noBody?: boolean;
		force?: boolean;
	} = {}
) {
	const payload: Record<string, unknown> = {};
	if (opts.mode) payload.mode = opts.mode;
	if (opts.force !== undefined) payload.force = opts.force;
	return h.json<ApplicationBody & ErrorBody>(`${BASE}/jobs/${jobId}/apply`, {
		method: 'POST',
		tier: 'friend',
		userId: opts.userId ?? OWNER,
		...(opts.noBody ? {} : { body: JSON.stringify(payload) }),
	});
}

function setStatus(
	id: string,
	body: { status: string; error?: string; evidence?: Record<string, unknown> },
	userId = OWNER
) {
	return h.json<ApplicationBody & ErrorBody>(`${BASE}/applications/${id}/status`, {
		method: 'POST',
		tier: 'friend',
		userId,
		body: JSON.stringify(body),
	});
}

function approve(id: string, userId = OWNER) {
	return h.json<ApplicationBody & ErrorBody>(`${BASE}/applications/${id}/approve`, {
		method: 'POST',
		tier: 'friend',
		userId,
	});
}

function list(query = '', userId = OWNER) {
	return h.json<ApplicationsBody>(`${BASE}/applications${query}`, {
		tier: 'friend',
		userId,
	});
}

before(async () => {
	h = await createHarness();
	await seedJob(h.db, {
		id: 'ap-1',
		title: 'Senior Engineer',
		company: 'Acme',
		location: 'Remote',
	});
	await seedJob(h.db, { id: 'ap-2', title: 'Staff Engineer', company: 'Globex' });
	await seedJob(h.db, { id: 'ap-3', title: 'Engineering Manager', company: 'Initech' });
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM applications').run();
	await h.db.prepare('DELETE FROM job_states').run();
	await seedJobState(h.db, {
		job_id: 'ap-1',
		user_id: OWNER,
		state: 'interested',
		variant_slug: 'acme-slug',
	});
});

after(async () => {
	await h.dispose();
});

describe('applications — auth', () => {
	it('403s unauthenticated callers on every route', async () => {
		for (const [path, method] of [
			[`${BASE}/jobs/ap-1/apply`, 'POST'],
			[`${BASE}/applications`, 'GET'],
			[`${BASE}/applications/some-id/status`, 'POST'],
			[`${BASE}/applications/some-id/approve`, 'POST'],
		] as const) {
			const res = await h.fetch(path, { method });
			assert.equal(res.status, 403, `${method} ${path}`);
		}
	});

	it('403s a public-tier caller even with a valid edge secret', async () => {
		const res = await h.fetch(`${BASE}/jobs/ap-1/apply`, { method: 'POST', tier: 'public' });
		assert.equal(res.status, 403);
	});
});

describe('POST /jobs/:id/apply', () => {
	it('404s an unknown job', async () => {
		const { status } = await apply('nope');
		assert.equal(status, 404);
	});

	it('409s when the job has no job_states row at all', async () => {
		const { status, body } = await apply('ap-2');
		assert.equal(status, 409);
		assert.match(body.message, /packet/i);
	});

	it('409s when the job_states row carries no variant_slug', async () => {
		await seedJobState(h.db, { job_id: 'ap-2', user_id: OWNER, state: 'interested' });
		const { status } = await apply('ap-2');
		assert.equal(status, 409);
	});

	it('queues with mode defaulting to review, packet slug copied from job_states', async () => {
		const { status, body } = await apply('ap-1');
		assert.equal(status, 200);
		const app = body.data.application;
		assert.equal(app.job_id, 'ap-1');
		assert.equal(app.variant_slug, 'acme-slug');
		assert.equal(app.mode, 'review');
		assert.equal(app.status, 'queued');
		assert.equal(app.error, null);
		assert.equal(app.evidence, null);
		assert.ok(app.id);
		assert.ok(app.created_at);
	});

	it('accepts a body-less POST (defaults still apply)', async () => {
		const { status, body } = await apply('ap-1', { noBody: true });
		assert.equal(status, 200);
		assert.equal(body.data.application.mode, 'review');
	});

	it('honours mode: auto', async () => {
		const { body } = await apply('ap-1', { mode: 'auto' });
		assert.equal(body.data.application.mode, 'auto');
	});

	it('re-apply re-queues: same row id, status reset, error/evidence cleared, mode updated', async () => {
		const first = await apply('ap-1');
		const id = first.body.data.application.id;

		// Drive it to a terminal failure with evidence, as the runner would.
		await setStatus(id, {
			status: 'failed',
			error: 'DOM drift',
			evidence: { screenshot: '/shots/1.png' },
		});

		const second = await apply('ap-1', { mode: 'auto' });
		assert.equal(second.status, 200);
		const app = second.body.data.application;
		assert.equal(app.id, id, 'UNIQUE(user_id, job_id) upsert must keep one row');
		assert.equal(app.status, 'queued');
		assert.equal(app.error, null);
		assert.equal(app.evidence, null);
		assert.equal(app.mode, 'auto');
		assert.equal(app.created_at, first.body.data.application.created_at);
	});

	it('picks up a re-minted packet slug on re-apply', async () => {
		await apply('ap-1');
		await h.db
			.prepare(`UPDATE job_states SET variant_slug = 'acme-slug-v2' WHERE job_id = 'ap-1'`)
			.run();
		const { body } = await apply('ap-1');
		assert.equal(body.data.application.variant_slug, 'acme-slug-v2');
	});

	it('is per-user: another user without a packet still 409s on the same job', async () => {
		await apply('ap-1');
		const { status } = await apply('ap-1', { userId: 'someone-else' });
		assert.equal(status, 409);
	});
});

describe('GET /applications', () => {
	it('returns the queue joined with the job, newest first', async () => {
		await seedJobState(h.db, {
			job_id: 'ap-2',
			user_id: OWNER,
			state: 'interested',
			variant_slug: 'globex-slug',
		});
		await apply('ap-1');
		await apply('ap-2');
		// Distinct updated_at values to exercise the ORDER BY.
		await h.db
			.prepare(
				`UPDATE applications SET updated_at = '2026-08-01T00:00:00.000Z' WHERE job_id = 'ap-1'`
			)
			.run();
		await h.db
			.prepare(
				`UPDATE applications SET updated_at = '2026-08-10T00:00:00.000Z' WHERE job_id = 'ap-2'`
			)
			.run();

		const { status, body } = await list();
		assert.equal(status, 200);
		assert.deepEqual(
			body.data.applications.map((a) => a.job_id),
			['ap-2', 'ap-1']
		);
		const globex = body.data.applications[0];
		assert.equal(globex.title, 'Staff Engineer');
		assert.equal(globex.company, 'Globex');
		assert.equal(globex.location, 'Remote');
		assert.equal(globex.variant_slug, 'globex-slug');
	});

	it('filters by ?status=', async () => {
		await seedJobState(h.db, {
			job_id: 'ap-2',
			user_id: OWNER,
			state: 'interested',
			variant_slug: 'globex-slug',
		});
		await apply('ap-1');
		const second = await apply('ap-2');
		await setStatus(second.body.data.application.id, { status: 'filled' });

		const filled = await list('?status=filled');
		assert.deepEqual(
			filled.body.data.applications.map((a) => a.job_id),
			['ap-2']
		);
		const queued = await list('?status=queued');
		assert.deepEqual(
			queued.body.data.applications.map((a) => a.job_id),
			['ap-1']
		);
	});

	it('400s an unknown status filter', async () => {
		const res = await h.fetch(`${BASE}/applications?status=bogus`, {
			tier: 'friend',
			userId: OWNER,
		});
		assert.equal(res.status, 400);
	});

	it("does not leak another user's applications", async () => {
		await apply('ap-1');
		const { status, body } = await list('', 'someone-else');
		assert.equal(status, 200);
		assert.deepEqual(body.data.applications, []);
	});

	it('returns an empty list when the caller queued nothing', async () => {
		const { status, body } = await list();
		assert.equal(status, 200);
		assert.deepEqual(body.data.applications, []);
	});
});

describe('POST /applications/:id/status', () => {
	it('404s an unknown application id', async () => {
		const { status } = await setStatus('nope', { status: 'filled' });
		assert.equal(status, 404);
	});

	it("404s another user's application (no existence leak)", async () => {
		const { body } = await apply('ap-1');
		const { status } = await setStatus(
			body.data.application.id,
			{ status: 'filled' },
			'someone-else'
		);
		assert.equal(status, 404);
	});

	it('records the transition with error and evidence, bumping updated_at', async () => {
		const first = await apply('ap-1');
		const id = first.body.data.application.id;
		const { status, body } = await setStatus(id, {
			status: 'needs_manual',
			error: 'hard captcha',
			evidence: { screenshot: '/shots/captcha.png', deep_link: 'https://jobs.ashbyhq.com/x' },
		});
		assert.equal(status, 200);
		const app = body.data.application;
		assert.equal(app.status, 'needs_manual');
		assert.equal(app.error, 'hard captcha');
		assert.deepEqual(app.evidence, {
			screenshot: '/shots/captcha.png',
			deep_link: 'https://jobs.ashbyhq.com/x',
		});
		assert.notEqual(app.updated_at, first.body.data.application.updated_at);
	});

	it('accepts any transition for v1 (approved → queued included)', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		for (const s of ['submitted', 'queued', 'filled', 'failed', 'approved']) {
			const { status, body: b } = await setStatus(id, { status: s });
			assert.equal(status, 200, `→ ${s}`);
			assert.equal(b.data.application.status, s);
		}
	});

	it('keeps evidence when a later transition omits it, but clears a stale error', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, {
			status: 'failed',
			error: 'timeout',
			evidence: { screenshot: '/shots/form.png' },
		});
		const { body: after } = await setStatus(id, { status: 'submitted' });
		assert.deepEqual(after.data.application.evidence, { screenshot: '/shots/form.png' });
		assert.equal(after.data.application.error, null);
	});

	it('400s an invalid status value', async () => {
		const { body } = await apply('ap-1');
		const res = await h.fetch(`${BASE}/applications/${body.data.application.id}/status`, {
			method: 'POST',
			tier: 'friend',
			userId: OWNER,
			body: JSON.stringify({ status: 'shipped' }),
		});
		assert.equal(res.status, 400);
	});
});

const FP = 'a'.repeat(64);
const OTHER_FP = 'b'.repeat(64);

describe('POST /applications/:id/approve', () => {
	it('404s an unknown application id', async () => {
		const { status } = await approve('nope');
		assert.equal(status, 404);
	});

	it("404s another user's application", async () => {
		const { body } = await apply('ap-1');
		const { status } = await approve(body.data.application.id, 'someone-else');
		assert.equal(status, 404);
	});

	it("approves from 'filled'", async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, {
			status: 'filled',
			evidence: { screenshot: '/shots/filled.png', fingerprint: FP },
		});

		const { status, body: approved } = await approve(id);
		assert.equal(status, 200);
		assert.equal(approved.data.application.status, 'approved');
		// Approval must not disturb the runner's evidence.
		assert.deepEqual(approved.data.application.evidence, {
			screenshot: '/shots/filled.png',
			fingerprint: FP,
		});
	});

	// The point of the column: an approval has to say WHICH application was
	// approved, or the runner re-fills from a fresh LLM draft and sends whatever
	// comes back — approve screenshot A, send application B.
	it('records the approved fill on the row', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled', evidence: { fingerprint: FP } });

		const { body: approved } = await approve(id);
		assert.equal(approved.data.application.approved_fingerprint, FP);
	});

	it('409s a fill that carries no fingerprint to bind to', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled', evidence: { screenshot: '/shots/filled.png' } });

		const { status, body: b } = await approve(id);
		assert.equal(status, 409);
		assert.match(b.message, /fingerprint/);
	});

	it('409s a fill whose evidence is missing entirely', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled' });

		const { status } = await approve(id);
		assert.equal(status, 409);
	});

	it('409s a non-string or empty fingerprint', async () => {
		for (const bad of [42, '', null, { nested: FP }]) {
			const { body } = await apply('ap-1');
			const id = body.data.application.id;
			await setStatus(id, { status: 'filled', evidence: { fingerprint: bad } });
			const { status } = await approve(id);
			assert.equal(status, 409, `fingerprint ${JSON.stringify(bad)}`);
			await setStatus(id, { status: 'queued' });
		}
	});

	it('a re-fill after approval drops the approval', async () => {
		// Otherwise the re-filled row inherits an approval given to content the
		// owner has not seen — which is the whole failure, one status apart.
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled', evidence: { fingerprint: FP } });
		await approve(id);

		const { body: refilled } = await setStatus(id, {
			status: 'filled',
			evidence: { fingerprint: OTHER_FP },
		});
		assert.equal(refilled.data.application.approved_fingerprint, null);
	});

	it('an approved row keeps its fingerprint through submission', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled', evidence: { fingerprint: FP } });
		await approve(id);

		const { body: sent } = await setStatus(id, { status: 'submitted' });
		assert.equal(sent.data.application.approved_fingerprint, FP);
	});

	it('a failed submit drops the approval rather than leaving it live', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled', evidence: { fingerprint: FP } });
		await approve(id);

		const { body: failed } = await setStatus(id, { status: 'failed', error: 'submit failed' });
		assert.equal(failed.data.application.approved_fingerprint, null);
	});

	it("409s from any status that is not 'filled'", async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		for (const s of ['queued', 'approved', 'submitted', 'needs_manual', 'failed']) {
			await setStatus(id, { status: s });
			const { status, body: b } = await approve(id);
			assert.equal(status, 409, `from ${s}`);
			assert.match(b.message, /filled/);
		}
	});
});

/**
 * Queueing an application against a posting that has already been taken down.
 *
 * The signal is not age. It is that a posting stopped appearing in scrapes of
 * its own board while its siblings kept being seen — which is why every test
 * here fixes both stamps rather than leaning on wall-clock time.
 */
describe('POST /jobs/:id/apply — delisted postings', () => {
	const RECENT = '2026-09-01T06:00:00.000Z';
	const STALE = '2026-08-14T06:00:00.000Z';

	async function seedBoard(
		jobId: string,
		lastSeen: string | null,
		opts: { ats?: string | null; slug?: string | null; siblingSeen?: string } = {}
	) {
		const ats = opts.ats === undefined ? 'greenhouse' : opts.ats;
		// One board per test. Rows persist across tests in this describe, so a
		// shared slug lets an earlier test's freshly-seen sibling set the board's
		// newest stamp — which is precisely the input under test.
		const slug = opts.slug === undefined ? `board-${jobId}` : opts.slug;
		await seedJob(h.db, { id: jobId, ats, slug, last_seen_at: lastSeen });
		await seedJob(h.db, {
			id: `${jobId}-sibling`,
			ats,
			slug,
			last_seen_at: opts.siblingSeen ?? RECENT,
		});
		await seedJobState(h.db, {
			job_id: jobId,
			user_id: OWNER,
			state: 'interested',
			variant_slug: 'v-delisted',
		});
	}

	it('refuses a posting its board has stopped listing', async () => {
		await seedBoard('gone-1', STALE);
		const { status, body } = await apply('gone-1');
		assert.equal(status, 409);
		assert.match(body.message, /taken down/);
	});

	it('queues it anyway when the owner overrules', async () => {
		// The owner can open the page; this is an inference, and they win.
		await seedBoard('gone-2', STALE);
		const { status, body } = await apply('gone-2', { force: true });
		assert.equal(status, 200);
		assert.equal(body.data.application.status, 'queued');
	});

	it('queues a posting still being seen', async () => {
		await seedBoard('live-1', RECENT);
		assert.equal((await apply('live-1')).status, 200);
	});

	it('does not call every job dead when the whole board went quiet', async () => {
		// The failure that would matter most: a disabled target, a broken
		// scraper or lapsed auth freezes EVERY job on the board together. None
		// of them has fallen behind its siblings, so none is delisted.
		await seedBoard('quiet-1', STALE, { siblingSeen: STALE });
		assert.equal((await apply('quiet-1')).status, 200);
	});

	it('does not judge keyword-feed jobs, which have no board', async () => {
		await seedBoard('kw-1', STALE, { ats: null, slug: null });
		assert.equal((await apply('kw-1')).status, 200);
	});

	it('does not judge a job that has never been stamped', async () => {
		await seedBoard('nostamp-1', null);
		assert.equal((await apply('nostamp-1')).status, 200);
	});

	it('tolerates the spread of stamps within one scrape run', async () => {
		// A run arrives as batches of 25, each stamped as it lands, so jobs from
		// the same run differ by minutes. Those are not delisted.
		await seedBoard('batch-1', '2026-09-01T05:58:00.000Z');
		assert.equal((await apply('batch-1')).status, 200);
	});
});

describe('job_closed', () => {
	it('is an accepted terminal status', async () => {
		const { body } = await apply('ap-1');
		const { status, body: closed } = await setStatus(body.data.application.id, {
			status: 'job_closed',
			error: 'the posting is no longer listed on its board',
		});
		assert.equal(status, 200);
		assert.equal(closed.data.application.status, 'job_closed');
	});

	it('re-queueing drops an approval given to the previous fill', async () => {
		const { body } = await apply('ap-1');
		const id = body.data.application.id;
		await setStatus(id, { status: 'filled', evidence: { fingerprint: FP } });
		await approve(id);

		const { body: requeued } = await apply('ap-1');
		assert.equal(requeued.data.application.status, 'queued');
		assert.equal(requeued.data.application.approved_fingerprint, null);
	});
});
