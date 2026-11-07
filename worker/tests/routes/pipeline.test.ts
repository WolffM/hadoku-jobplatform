/**
 * V5 pipeline — the timeline PUT /state writes, and the routes in
 * routes/jobs/pipeline.ts: GET /pipeline, PATCH /jobs/{id}/tracking, and
 * GET/POST/DELETE /jobs/{id}/events.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Tracking {
	notes: string | null;
	priority: 1 | 2 | 3 | null;
	follow_up_at: string | null;
	contact_name: string | null;
	contact_email: string | null;
}

interface Item {
	job_id: string;
	title: string;
	state: string;
	tracking: Tracking;
	application_status: string | null;
	applied_at: string | null;
	last_event_at: string | null;
}

interface Event {
	id: number;
	kind: string;
	from_state: string | null;
	to_state: string | null;
	note: string | null;
	occurred_at: string;
}

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, { id: 'p-1', title: 'Senior Engineer', company: 'Acme' });
	await seedJob(h.db, { id: 'p-2', title: 'Staff Engineer', company: 'Globex' });
	await seedJob(h.db, { id: 'p-3', title: 'Principal Engineer', company: 'Initech' });
});

beforeEach(async () => {
	for (const t of ['job_events', 'job_states', 'applications']) {
		await h.db.prepare(`DELETE FROM ${t}`).run();
	}
});

after(async () => {
	await h.dispose();
});

function call<T>(path: string, method = 'GET', body?: unknown, userId = ALICE, tier = 'friend') {
	return h.json<T>(`${BASE}${path}`, {
		method,
		tier,
		userId,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

const setState = (id: string, state: string, userId = ALICE) =>
	call(`/jobs/${id}/state`, 'PUT', { state }, userId);
const pipeline = (userId = ALICE, qs = '') =>
	call<{ data: { items: Item[] } }>(`/pipeline${qs}`, 'GET', undefined, userId);
const events = (id: string, userId = ALICE) =>
	call<{ data: { events: Event[] } }>(`/jobs/${id}/events`, 'GET', undefined, userId);
const track = (id: string, body: unknown, userId = ALICE) =>
	call<{ data: { tracking: Tracking } }>(`/jobs/${id}/tracking`, 'PATCH', body, userId);
const logEvent = (id: string, body: unknown, userId = ALICE) =>
	call<{ data: { event: Event } }>(`/jobs/${id}/events`, 'POST', body, userId);

describe('auth', () => {
	for (const [method, path] of [
		['GET', '/pipeline'],
		['PATCH', '/jobs/p-1/tracking'],
		['GET', '/jobs/p-1/events'],
		['POST', '/jobs/p-1/events'],
		['DELETE', '/jobs/p-1/events/1'],
	] as const) {
		it(`${method} ${path} 403s an unauthenticated caller`, async () => {
			const res = await h.fetch(`${BASE}${path}`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
			});
			assert.equal(res.status, 403);
		});
	}

	it('refuses a friend naming an owner — ownerName is honoured, never ignored', async () => {
		const { status } = await call('/pipeline?ownerName=Hadoku');
		assert.equal(status, 403);
	});

	it("lets admin read the named owner's pipeline, not its own", async () => {
		await setState('p-1', 'applied', 'user-hadoku');
		await setState('p-2', 'applied', ALICE);
		const { status, body } = await call<{ data: { items: Item[] } }>(
			'/pipeline?ownerName=Hadoku',
			'GET',
			undefined,
			ALICE,
			'admin'
		);
		assert.equal(status, 200);
		assert.deepEqual(
			body.data.items.map((i) => i.job_id),
			['p-1']
		);
	});
});

describe('PUT /jobs/{id}/state — the timeline', () => {
	it('accepts the V5 states', async () => {
		for (const state of ['interviewing', 'offered', 'rejected']) {
			const { status } = await setState('p-1', state);
			assert.equal(status, 200, state);
		}
	});

	it('still refuses a state nobody defined', async () => {
		const { status } = await setState('p-1', 'ghosted');
		assert.equal(status, 400);
	});

	it('writes one row per transition, from → to, and none for a repeat', async () => {
		await setState('p-1', 'saved');
		await setState('p-1', 'applied');
		await setState('p-1', 'applied');
		await setState('p-1', 'interviewing');
		const { body } = await events('p-1');
		assert.deepEqual(
			body.data.events.map((e) => [e.kind, e.from_state, e.to_state]),
			[
				['state', null, 'saved'],
				['state', 'saved', 'applied'],
				['state', 'applied', 'interviewing'],
			]
		);
	});

	it('DELETE clears the timeline with the state, and only for that person', async () => {
		await setState('p-1', 'applied');
		await setState('p-1', 'applied', BOB);
		await call('/jobs/p-1/state', 'DELETE');
		assert.equal((await events('p-1')).body.data.events.length, 0);
		assert.equal((await events('p-1', BOB)).body.data.events.length, 1);
	});
});

describe('GET /pipeline', () => {
	it("lists the caller's postings, newest change first, with what the timeline knows", async () => {
		await setState('p-1', 'applied');
		await setState('p-2', 'saved');
		await setState('p-1', 'interviewing');
		const { status, body } = await pipeline();
		assert.equal(status, 200);
		const [first, second] = body.data.items;
		assert.equal(first.job_id, 'p-1');
		assert.equal(first.state, 'interviewing');
		assert.ok(first.applied_at, 'applied_at comes from the applied transition');
		assert.ok(first.last_event_at && first.last_event_at >= first.applied_at!);
		assert.equal(second.job_id, 'p-2');
		assert.equal(second.applied_at, null, 'never applied');
		assert.deepEqual(second.tracking, {
			notes: null,
			priority: null,
			follow_up_at: null,
			contact_name: null,
			contact_email: null,
		});
	});

	it('leaves dismissed postings out unless asked', async () => {
		await setState('p-1', 'dismissed');
		await setState('p-2', 'saved');
		assert.deepEqual(
			(await pipeline()).body.data.items.map((i) => i.job_id),
			['p-2']
		);
		assert.deepEqual(
			(await pipeline(ALICE, '?include_dismissed=true')).body.data.items
				.map((i) => i.job_id)
				.sort(),
			['p-1', 'p-2']
		);
	});

	it("is per person — Bob's pipeline never shows Alice's postings", async () => {
		await setState('p-1', 'applied');
		assert.equal((await pipeline(BOB)).body.data.items.length, 0);
	});

	it("carries the apply queue's status for a queued posting", async () => {
		await setState('p-3', 'saved');
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
				 VALUES ('app-1', ?, 'p-3', 'slug', 'review', 'submitted', ?, ?)`
			)
			.bind(ALICE, now, now)
			.run();
		const item = (await pipeline()).body.data.items.find((i) => i.job_id === 'p-3');
		assert.equal(item?.application_status, 'submitted');
	});

	it('skips a stored state this code does not know rather than inventing a column', async () => {
		await h.db
			.prepare(
				`INSERT INTO job_states (job_id, user_id, state, notes, updated_at)
				 VALUES ('p-1', ?, 'legacy-state', NULL, '2026-01-01T00:00:00Z')`
			)
			.bind(ALICE)
			.run();
		const { status, body } = await pipeline();
		assert.equal(status, 200);
		assert.equal(body.data.items.length, 0);
	});
});

describe('PATCH /jobs/{id}/tracking', () => {
	it('sets only the fields named, and null clears one', async () => {
		await setState('p-1', 'applied');
		await track('p-1', { priority: 1, contact_name: 'Pat', follow_up_at: '2026-11-20' });
		const { status, body } = await track('p-1', { contact_name: null, notes: 'sent thank-you' });
		assert.equal(status, 200);
		assert.deepEqual(body.data.tracking, {
			notes: 'sent thank-you',
			priority: 1,
			follow_up_at: '2026-11-20',
			contact_name: null,
			contact_email: null,
		});
	});

	it('stores an emptied text box as null, not as an empty string', async () => {
		await setState('p-1', 'applied');
		await track('p-1', { notes: 'x' });
		const { body } = await track('p-1', { notes: '   ' });
		assert.equal(body.data.tracking.notes, null);
	});

	it('shows up on GET /pipeline', async () => {
		await setState('p-1', 'applied');
		await track('p-1', { contact_email: 'pat@acme.test', priority: 2 });
		const item = (await pipeline()).body.data.items[0];
		assert.equal(item.tracking.contact_email, 'pat@acme.test');
		assert.equal(item.tracking.priority, 2);
	});

	it('shows up on GET /jobs/{id}, and is null for a posting with no state', async () => {
		await setState('p-1', 'interviewing');
		await track('p-1', { follow_up_at: '2026-11-20', contact_name: 'Pat' });
		const detail = (id: string) =>
			call<{ data: { job: { tracking: Tracking | null } } }>(`/jobs/${id}`);
		const t = (await detail('p-1')).body.data.job.tracking;
		assert.deepEqual(t, {
			notes: null,
			priority: null,
			follow_up_at: '2026-11-20',
			contact_name: 'Pat',
			contact_email: null,
		});
		assert.equal((await detail('p-2')).body.data.job.tracking, null);
	});

	it('409s a posting with no state, and 404s one that does not exist', async () => {
		assert.equal((await track('p-1', { notes: 'x' })).status, 409);
		assert.equal((await track('nope', { notes: 'x' })).status, 404);
	});

	it('400s an empty body, a priority off the scale, a bad date and a bad email', async () => {
		await setState('p-1', 'applied');
		for (const bad of [
			{},
			{ priority: 4 },
			{ follow_up_at: 'next tuesday' },
			{ contact_email: 'not an email' },
		]) {
			assert.equal((await track('p-1', bad)).status, 400, JSON.stringify(bad));
		}
	});

	it("never touches another person's row", async () => {
		await setState('p-1', 'applied', BOB);
		assert.equal((await track('p-1', { notes: 'mine' })).status, 409);
		const bob = await h.db
			.prepare('SELECT notes FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('p-1', BOB)
			.first<{ notes: string | null }>();
		assert.equal(bob?.notes, null);
	});
});

describe('POST / DELETE /jobs/{id}/events', () => {
	it('logs a person event, with occurred_at as given — a bare date is that day in UTC', async () => {
		await setState('p-1', 'interviewing');
		const { status, body } = await logEvent('p-1', {
			kind: 'interview',
			note: 'Onsite with the platform team',
			occurred_at: '2026-11-03',
		});
		assert.equal(status, 201);
		assert.equal(body.data.event.kind, 'interview');
		assert.equal(body.data.event.occurred_at, '2026-11-03T00:00:00.000Z');
		const kinds = (await events('p-1')).body.data.events.map((e) => e.kind);
		assert.deepEqual(kinds.sort(), ['interview', 'state']);
	});

	it('orders the timeline by when things happened, not when they were logged', async () => {
		await setState('p-1', 'applied');
		await logEvent('p-1', { kind: 'contact', note: 'recruiter screen', occurred_at: '2020-01-01' });
		const first = (await events('p-1')).body.data.events[0];
		assert.equal(first.kind, 'contact');
	});

	it('409s a posting not in the pipeline, 404s a missing job, 400s a blank note or a state kind', async () => {
		assert.equal((await logEvent('p-1', { kind: 'note', note: 'x' })).status, 409);
		assert.equal((await logEvent('nope', { kind: 'note', note: 'x' })).status, 404);
		await setState('p-1', 'applied');
		assert.equal((await logEvent('p-1', { kind: 'note', note: '  ' })).status, 400);
		assert.equal(
			(await logEvent('p-1', { kind: 'state', note: 'x' })).status,
			400,
			'state rows are PUT /state only'
		);
	});

	it('deletes a person event, but never a state transition', async () => {
		await setState('p-1', 'applied');
		const note = (await logEvent('p-1', { kind: 'note', note: 'x' })).body.data.event;
		const transition = (await events('p-1')).body.data.events.find((e) => e.kind === 'state')!;

		const gone = await call<{ data: { deleted: boolean } }>(
			`/jobs/p-1/events/${note.id}`,
			'DELETE'
		);
		assert.equal(gone.body.data.deleted, true);
		const kept = await call<{ data: { deleted: boolean } }>(
			`/jobs/p-1/events/${transition.id}`,
			'DELETE'
		);
		assert.equal(kept.body.data.deleted, false);
		assert.deepEqual(
			(await events('p-1')).body.data.events.map((e) => e.kind),
			['state']
		);
	});

	it("cannot delete another person's event", async () => {
		await setState('p-1', 'applied', BOB);
		const bobs = (await logEvent('p-1', { kind: 'note', note: 'bob' }, BOB)).body.data.event;
		const res = await call<{ data: { deleted: boolean } }>(`/jobs/p-1/events/${bobs.id}`, 'DELETE');
		assert.equal(res.body.data.deleted, false);
		assert.equal((await events('p-1', BOB)).body.data.events.length, 2);
	});
});
