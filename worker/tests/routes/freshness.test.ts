/**
 * last_seen_at and `closed` on GET /pipeline and GET /jobs/:id: a posting is
 * closed when it has fallen behind its own board's scrapes (freshness.ts),
 * never because the whole board went quiet.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NIGHT = '2026-11-09T07:05:00.000Z';
const EARLIER = '2026-11-06T07:05:00.000Z';

let h: Harness;

before(async () => {
	h = await createHarness();
	const board = (
		id: string,
		slug: string,
		last_seen_at: string | null,
		ats: string | null = 'greenhouse'
	) =>
		seedJob(h.db, {
			id,
			ats,
			slug: ats ? slug : null,
			url: `https://example.com/${id}`,
			last_seen_at,
			scraped_at: '2026-10-01T00:00:00.000Z',
		});
	await board('live', 'acme', NIGHT);
	await board('sibling', 'acme', '2026-11-09T07:30:00.000Z'); // same run, later batch
	await board('pulled', 'acme', EARLIER);
	await board('quiet-a', 'globex', EARLIER); // the whole board stopped advancing together
	await board('quiet-b', 'globex', EARLIER);
	await board('pasted', '', null, null); // no board to be absent from
	for (const id of ['live', 'pulled', 'quiet-a', 'pasted'])
		await seedJobState(h.db, { job_id: id, user_id: ALICE, state: 'applied' });
});

after(async () => {
	await h.dispose();
});

describe('posting freshness', () => {
	it('GET /pipeline says which tracked postings were taken down', async () => {
		const res = await h.json<{
			data: { items: { job_id: string; closed: boolean; last_seen_at: string | null }[] };
		}>(`${BASE}/pipeline`, { tier: 'friend', userId: ALICE });
		assert.equal(res.status, 200);
		const by = Object.fromEntries(
			res.body.data.items.map((i) => [i.job_id, [i.closed, i.last_seen_at]])
		);
		assert.deepEqual(by, {
			live: [false, NIGHT],
			pulled: [true, EARLIER],
			'quiet-a': [false, EARLIER],
			pasted: [false, null],
		});
	});

	it('GET /jobs/:id says the same, anonymous or not', async () => {
		const closed = async (id: string) =>
			(
				await h.json<{ data: { job: { closed: boolean; last_seen_at: string | null } } }>(
					`${BASE}/jobs/${id}`
				)
			).body.data.job;
		assert.deepEqual(await closed('pulled'), {
			...(await closed('pulled')),
			closed: true,
			last_seen_at: EARLIER,
		});
		assert.equal((await closed('sibling')).closed, false);
		assert.equal((await closed('quiet-b')).closed, false);
		assert.equal((await closed('pasted')).closed, false);
	});
});
