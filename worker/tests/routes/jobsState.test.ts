/**
 * PUT / DELETE /jobs/{id}/state — per-user triage.
 *
 * The interesting behaviours are the upsert's COALESCE on variant_slug (a later
 * state change must not wipe the record of what packet was sent) and the fact
 * that state is genuinely per-user, not global.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob } from '../helpers/seed.ts';

interface StateBody {
	success: boolean;
	data: { job_id: string; state: string; updated_at: string };
}

interface ClearBody {
	success: boolean;
	data: { job_id: string; deleted: boolean };
}

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, { id: 'state-1', title: 'Senior Software Engineer' });
	await seedJob(h.db, { id: 'state-2', title: 'Staff Software Engineer' });
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM job_states').run();
});

after(async () => {
	await h.dispose();
});

function put(id: string, body: unknown, userId = 'user-one') {
	return h.json<StateBody>(`${BASE}/jobs/${id}/state`, {
		method: 'PUT',
		tier: 'friend',
		userId,
		body: JSON.stringify(body),
	});
}

describe('PUT /jobs/{id}/state — auth', () => {
	it('403s an unauthenticated caller', async () => {
		const res = await h.fetch(`${BASE}/jobs/state-1/state`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ state: 'saved' }),
		});
		assert.equal(res.status, 403);
	});

	it('403s a public-tier caller even with a valid edge secret', async () => {
		const res = await h.fetch(`${BASE}/jobs/state-1/state`, {
			method: 'PUT',
			tier: 'public',
			body: JSON.stringify({ state: 'saved' }),
		});
		assert.equal(res.status, 403);
	});

	it('admits tiers above friend, since tiers rank', async () => {
		for (const tier of ['friend', 'service', 'admin']) {
			const { status } = await put('state-1', { state: 'saved' }, `ranked-${tier}`);
			assert.equal(status, 200, `${tier} should outrank the friend gate`);
		}
	});
});

describe('PUT /jobs/{id}/state — writes', () => {
	it('creates a state row and echoes it back', async () => {
		const { status, body } = await put('state-1', { state: 'interested' });
		assert.equal(status, 200);
		assert.equal(body.data.job_id, 'state-1');
		assert.equal(body.data.state, 'interested');
		assert.ok(Date.parse(body.data.updated_at) > 0);

		const row = await h.db
			.prepare('SELECT state, variant_slug FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('state-1', 'user-one')
			.first<{ state: string; variant_slug: string | null }>();
		assert.equal(row?.state, 'interested');
		assert.equal(row?.variant_slug, null);
	});

	it('upserts rather than duplicating on a second write', async () => {
		await put('state-1', { state: 'interested' });
		await put('state-1', { state: 'applied' });

		const rows = await h.db
			.prepare('SELECT state FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('state-1', 'user-one')
			.all<{ state: string }>();
		assert.equal(rows.results.length, 1);
		assert.equal(rows.results[0].state, 'applied');
	});

	it('records a variant_slug and keeps it across a later slug-less change', async () => {
		await put('state-1', { state: 'applied', variant_slug: 'packet-xyz' });
		let row = await h.db
			.prepare('SELECT state, variant_slug FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('state-1', 'user-one')
			.first<{ state: string; variant_slug: string | null }>();
		assert.equal(row?.variant_slug, 'packet-xyz');

		// Moving applied → saved carries no slug; the record of what was sent
		// must survive (the COALESCE in the upsert).
		await put('state-1', { state: 'saved' });
		row = await h.db
			.prepare('SELECT state, variant_slug FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('state-1', 'user-one')
			.first<{ state: string; variant_slug: string | null }>();
		assert.equal(row?.state, 'saved');
		assert.equal(row?.variant_slug, 'packet-xyz', 'a slug-less update must not wipe the slug');
	});

	it('overwrites the slug when a fresh one is supplied', async () => {
		await put('state-1', { state: 'applied', variant_slug: 'first' });
		await put('state-1', { state: 'applied', variant_slug: 'second' });
		const row = await h.db
			.prepare('SELECT variant_slug FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('state-1', 'user-one')
			.first<{ variant_slug: string | null }>();
		assert.equal(row?.variant_slug, 'second');
	});

	it('keeps two users independent on the same job', async () => {
		await put('state-1', { state: 'saved' }, 'alice');
		await put('state-1', { state: 'dismissed' }, 'bob');

		const rows = await h.db
			.prepare('SELECT user_id, state FROM job_states WHERE job_id = ? ORDER BY user_id')
			.bind('state-1')
			.all<{ user_id: string; state: string }>();
		assert.deepEqual(rows.results, [
			{ user_id: 'alice', state: 'saved' },
			{ user_id: 'bob', state: 'dismissed' },
		]);
	});

	it('404s a state write against a job that does not exist', async () => {
		const { status, body } = await h.json<{ success: boolean; message: string }>(
			`${BASE}/jobs/ghost/state`,
			{
				method: 'PUT',
				tier: 'friend',
				body: JSON.stringify({ state: 'saved' }),
			}
		);
		assert.equal(status, 404);
		assert.equal(body.success, false);
		assert.match(body.message, /ghost/);
	});

	it('rejects a state outside the enum', async () => {
		const res = await h.fetch(`${BASE}/jobs/state-1/state`, {
			method: 'PUT',
			tier: 'friend',
			body: JSON.stringify({ state: 'thinking-about-it' }),
		});
		assert.equal(res.status, 400);
	});

	it('rejects a body with no state at all', async () => {
		const res = await h.fetch(`${BASE}/jobs/state-1/state`, {
			method: 'PUT',
			tier: 'friend',
			body: JSON.stringify({}),
		});
		assert.equal(res.status, 400);
	});
});

describe('DELETE /jobs/{id}/state', () => {
	it('403s an unauthenticated caller', async () => {
		const res = await h.fetch(`${BASE}/jobs/state-1/state`, { method: 'DELETE' });
		assert.equal(res.status, 403);
	});

	it('clears an existing row and reports deleted:true', async () => {
		await put('state-1', { state: 'saved' });
		const { status, body } = await h.json<ClearBody>(`${BASE}/jobs/state-1/state`, {
			method: 'DELETE',
			tier: 'friend',
		});
		assert.equal(status, 200);
		assert.equal(body.data.deleted, true);

		const row = await h.db
			.prepare('SELECT state FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('state-1', 'user-one')
			.first();
		assert.equal(row, null);
	});

	it('is idempotent — a second clear reports deleted:false, not an error', async () => {
		await put('state-1', { state: 'saved' });
		await h.json<ClearBody>(`${BASE}/jobs/state-1/state`, { method: 'DELETE', tier: 'friend' });
		const { status, body } = await h.json<ClearBody>(`${BASE}/jobs/state-1/state`, {
			method: 'DELETE',
			tier: 'friend',
		});
		assert.equal(status, 200);
		assert.equal(body.data.deleted, false);
	});

	it("clears only the caller's row", async () => {
		await put('state-1', { state: 'saved' }, 'alice');
		await put('state-1', { state: 'saved' }, 'bob');
		await h.json<ClearBody>(`${BASE}/jobs/state-1/state`, {
			method: 'DELETE',
			tier: 'friend',
			userId: 'alice',
		});
		const rows = await h.db
			.prepare('SELECT user_id FROM job_states WHERE job_id = ?')
			.bind('state-1')
			.all<{ user_id: string }>();
		assert.deepEqual(
			rows.results.map((r) => r.user_id),
			['bob']
		);
	});

	it('reports deleted:false for a job that never existed', async () => {
		const { status, body } = await h.json<ClearBody>(`${BASE}/jobs/ghost/state`, {
			method: 'DELETE',
			tier: 'friend',
		});
		assert.equal(status, 200);
		assert.equal(body.data.deleted, false);
	});
});
