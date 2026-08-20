import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const BASE = '/jobplatform/api';
const AUTH = {
	headers: { 'X-Edge-Auth': 'test-edge-secret', 'X-Hadoku-Tier': 'friend', 'X-User-Id': 'u-cull' },
};

let h: Harness;

before(async () => {
	h = await createHarness();
	const old = '2026-05-01T00:00:00.000Z'; // ~110 days before "now"
	const fresh = new Date().toISOString();
	await seedJob(h.db, { id: 'cull-old', title: 'Old dead posting', scraped_at: old });
	await h.db
		.prepare('UPDATE jobs SET last_seen_at = ?, posted_date = NULL WHERE id = ?')
		.bind(old, 'cull-old')
		.run();
	await seedJob(h.db, { id: 'cull-protected', title: 'Old but owner-touched', scraped_at: old });
	await h.db
		.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?')
		.bind(old, 'cull-protected')
		.run();
	await seedJobState(h.db, { job_id: 'cull-protected', user_id: 'u-cull', state: 'applied' });
	await seedJob(h.db, { id: 'cull-fresh', title: 'Fresh posting', scraped_at: fresh });
	await h.db
		.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?')
		.bind(fresh, 'cull-fresh')
		.run();
	// still-listed board job: posted long ago but seen this week
	await seedJob(h.db, { id: 'cull-alive', title: 'Old post still listed', scraped_at: old });
	await h.db
		.prepare('UPDATE jobs SET posted_date = ?, last_seen_at = ? WHERE id = ?')
		.bind(old, fresh, 'cull-alive')
		.run();
});

after(async () => {
	await h.dispose();
});

describe('POST /ingest/cull', () => {
	it('403s anonymously — maintenance is friend-gated', async () => {
		const res = await h.fetch(`${BASE}/ingest/cull`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('culls expired rows, spares owner-touched, fresh, and still-listed ones', async () => {
		const { status, body } = await h.json<{ success: boolean; data: { culled: number } }>(
			`${BASE}/ingest/cull`,
			{ method: 'POST', ...AUTH }
		);
		assert.equal(status, 200);
		assert.ok(body.data.culled >= 1, 'at least the dead row goes');
		const remaining = await h.db
			.prepare("SELECT id FROM jobs WHERE id LIKE 'cull-%' ORDER BY id")
			.all<{ id: string }>();
		assert.deepEqual(
			remaining.results.map((r) => r.id),
			['cull-alive', 'cull-fresh', 'cull-protected'],
			'only the untouchable dead row was deleted'
		);
	});
});
