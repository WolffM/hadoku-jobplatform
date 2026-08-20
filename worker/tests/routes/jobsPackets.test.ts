/**
 * GET /jobs/packets — the way back to every generated application packet.
 *
 * The interesting behaviours: only rows that actually carry a variant_slug
 * count as packets, they are strictly per-user, they come back newest first
 * joined with the job they belong to, and the static path must not be captured
 * by the /jobs/{id} param route (registration order in routes/jobs/index.ts).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

interface PacketsBody {
	success: boolean;
	data: {
		packets: Array<{
			job_id: string;
			title: string;
			company: string;
			location: string;
			state: string;
			variant_slug: string;
			updated_at: string;
		}>;
	};
}

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, {
		id: 'pk-1',
		title: 'Senior Software Engineer',
		company: 'Acme',
		location: 'Remote',
	});
	await seedJob(h.db, { id: 'pk-2', title: 'Staff Software Engineer', company: 'Globex' });
	await seedJob(h.db, { id: 'pk-3', title: 'Engineering Manager', company: 'Initech' });
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM job_states').run();
});

after(async () => {
	await h.dispose();
});

describe('GET /jobs/packets — auth', () => {
	it('403s an unauthenticated caller', async () => {
		const res = await h.fetch(`${BASE}/jobs/packets`);
		assert.equal(res.status, 403);
	});

	it('403s a public-tier caller even with a valid edge secret', async () => {
		const res = await h.fetch(`${BASE}/jobs/packets`, { tier: 'public' });
		assert.equal(res.status, 403);
	});
});

describe('GET /jobs/packets — listing', () => {
	it('returns only rows with a variant_slug, joined with the job', async () => {
		await seedJobState(h.db, {
			job_id: 'pk-1',
			user_id: 'packet-owner',
			state: 'applied',
			variant_slug: 'acme-slug',
		});
		// A triaged job with no minted packet is not a packet.
		await seedJobState(h.db, { job_id: 'pk-2', user_id: 'packet-owner', state: 'saved' });

		const { status, body } = await h.json<PacketsBody>(`${BASE}/jobs/packets`, {
			tier: 'friend',
			userId: 'packet-owner',
		});
		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(body.data.packets.length, 1);
		const p = body.data.packets[0];
		assert.equal(p.job_id, 'pk-1');
		assert.equal(p.title, 'Senior Software Engineer');
		assert.equal(p.company, 'Acme');
		assert.equal(p.location, 'Remote');
		assert.equal(p.state, 'applied');
		assert.equal(p.variant_slug, 'acme-slug');
		assert.equal(p.updated_at, '2026-08-01T00:00:00.000Z');
	});

	it('orders newest first by updated_at', async () => {
		// seedJobState stamps a fixed updated_at, so write the rows directly with
		// distinct timestamps to exercise the ORDER BY.
		const insert = (jobId: string, slug: string, at: string) =>
			h.db
				.prepare(
					`INSERT INTO job_states (job_id, user_id, state, notes, updated_at, variant_slug)
					 VALUES (?, 'packet-owner', 'applied', NULL, ?, ?)`
				)
				.bind(jobId, at, slug)
				.run();
		await insert('pk-1', 'oldest', '2026-08-01T00:00:00.000Z');
		await insert('pk-3', 'newest', '2026-08-10T00:00:00.000Z');
		await insert('pk-2', 'middle', '2026-08-05T00:00:00.000Z');

		const { body } = await h.json<PacketsBody>(`${BASE}/jobs/packets`, {
			tier: 'friend',
			userId: 'packet-owner',
		});
		assert.deepEqual(
			body.data.packets.map((p) => p.variant_slug),
			['newest', 'middle', 'oldest']
		);
	});

	it("does not leak another user's packets", async () => {
		await seedJobState(h.db, {
			job_id: 'pk-1',
			user_id: 'packet-owner',
			state: 'applied',
			variant_slug: 'theirs',
		});

		const { status, body } = await h.json<PacketsBody>(`${BASE}/jobs/packets`, {
			tier: 'friend',
			userId: 'someone-else',
		});
		assert.equal(status, 200);
		assert.deepEqual(body.data.packets, []);
	});

	it('returns an empty list when the caller has no packets', async () => {
		const { status, body } = await h.json<PacketsBody>(`${BASE}/jobs/packets`, {
			tier: 'friend',
			userId: 'packet-owner',
		});
		assert.equal(status, 200);
		assert.deepEqual(body.data.packets, []);
	});

	it('is not captured by the /jobs/{id} param route', async () => {
		// If registration order regressed, "packets" would be looked up as a job
		// id and 404. An authed call must hit the packets handler (200), and even
		// the unauthed 403 above (vs 404) proves the static route matched.
		const { status } = await h.json<PacketsBody>(`${BASE}/jobs/packets`, {
			tier: 'friend',
			userId: 'packet-owner',
		});
		assert.equal(status, 200);
	});
});
