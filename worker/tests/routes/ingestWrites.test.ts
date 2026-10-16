/**
 * What an ingest batch writes, and — the point of this file — what it leaves
 * alone.
 *
 * A scrape re-encounters nearly every posting it already has (~26k of them a
 * day on 2026-10-15, against ~500 new ones), so whatever ingest does per KNOWN
 * posting is the database's write bill. Each test here pins a write that used
 * to happen for nothing: the rank rows of already-ranked jobs, and the index
 * entries a liveness bump used to drag along with it.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile } from '../helpers/seed.ts';

const PROFILE = 'iw-p1';
const AUTH = { tier: 'service' as const, userId: 'iw-user' };

let h: Harness;

function job(id: string, title = 'Senior Software Engineer, Platform') {
	return {
		id,
		url: `https://boards.greenhouse.io/acme/jobs/${id}`,
		source_site: 'greenhouse',
		title,
		company: 'Acme',
		location: 'Remote - USA',
		description: 'We build things.',
	};
}

async function ingest(jobs: ReturnType<typeof job>[], board_slug = 'acme') {
	const { status, body } = await h.json<{ data: { accepted: number; skipped: number } }>(
		`${BASE}/ingest`,
		{
			method: 'POST',
			...AUTH,
			body: JSON.stringify({
				jobs,
				batch_number: 1,
				is_final: false,
				source: 'greenhouse',
				board_slug,
			}),
		}
	);
	assert.equal(status, 200);
	return body.data;
}

const rankRow = (jobId: string) =>
	h.db
		.prepare('SELECT bound FROM job_profile_rank WHERE profile_id = ? AND job_id = ?')
		.bind(PROFILE, jobId)
		.first<{ bound: number }>();

const marker = () =>
	h.db
		.prepare('SELECT max_job_rowid FROM job_profile_rank_state WHERE profile_id = ?')
		.bind(PROFILE)
		.first<{ max_job_rowid: number }>();

const head = async () =>
	Number(
		(await h.db.prepare('SELECT MAX(rowid) AS head FROM jobs').first<{ head: number }>())?.head
	);

before(async () => {
	h = await createHarness();
	await seedProfile(h.db, {
		id: PROFILE,
		user_id: 'iw-user',
		name: 'Writes',
		keywords: ['software engineer', 'platform'],
		track: 'either',
		levels: ['senior'],
		remote_pref: 'remote',
	});
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM job_profile_rank').run();
	await h.db.prepare('DELETE FROM job_profile_rank_state').run();
	await h.db.prepare('DELETE FROM jobs').run();
	await ingest([job('iw-known')]);
	const { status } = await h.json(`${BASE}/ingest/rebuild-rank?profile_id=${PROFILE}`, {
		method: 'POST',
		...AUTH,
	});
	assert.equal(status, 200);
});

after(async () => {
	await h.dispose();
});

describe('ingest ranking — only what is new', () => {
	it('ranks the new job and does not rewrite an already-ranked one', async () => {
		// A sentinel no scorer produces: if ingest re-upserted the known job it
		// would come back as the real bound.
		await h.db
			.prepare('UPDATE job_profile_rank SET bound = 0.123 WHERE job_id = ?')
			.bind('iw-known')
			.run();

		const res = await ingest([job('iw-known'), job('iw-new')]);
		assert.equal(res.accepted, 1);

		assert.equal((await rankRow('iw-known'))?.bound, 0.123, 'the known job was re-ranked');
		assert.ok(await rankRow('iw-new'), 'the new job has no rank row');
		assert.equal(Number((await marker())?.max_job_rowid), await head(), 'marker covers the corpus');
	});

	it('catches up a job an earlier extension missed', async () => {
		// Inserted past the marker without being ranked — what a failed
		// extension leaves behind. Ranking the payload alone never revisits it.
		await seedJob(h.db, { id: 'iw-missed', url: 'https://boards.greenhouse.io/acme/jobs/missed' });
		await ingest([job('iw-later')]);
		assert.ok(await rankRow('iw-missed'), 'the missed job is still unranked');
		assert.ok(await rankRow('iw-later'));
	});

	it('leaves a profile whose criteria changed for the feed to rebuild', async () => {
		const before = Number((await marker())?.max_job_rowid);
		// Changed underneath the ranking, the way only a direct write can: a
		// profile edit through the API clears and rebuilds instead.
		await h.db
			.prepare(`UPDATE profiles SET keywords = '["designer"]' WHERE id = ?`)
			.bind(PROFILE)
			.run();
		await ingest([job('iw-after-edit')]);
		assert.equal(
			await rankRow('iw-after-edit'),
			null,
			'ranked under criteria it was not built for'
		);
		assert.equal(
			Number((await marker())?.max_job_rowid),
			before,
			'the marker moved, blessing rows built under the old criteria as current'
		);
	});
});

describe('ingest liveness — only what changed', () => {
	it('bumps last_seen_at on a re-seen posting', async () => {
		await h.db
			.prepare(`UPDATE jobs SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`)
			.bind('iw-known')
			.run();
		await ingest([job('iw-known')]);
		const row = await h.db
			.prepare('SELECT last_seen_at FROM jobs WHERE id = ?')
			.bind('iw-known')
			.first<{ last_seen_at: string }>();
		assert.ok(
			row && row.last_seen_at > '2026-10-01',
			`last_seen_at stayed at ${row?.last_seen_at}`
		);
	});

	it('a liveness bump writes one row per posting — last_seen_at is in no index', async () => {
		const res = await h.db
			.prepare('UPDATE jobs SET last_seen_at = ? WHERE url IN (?)')
			.bind(new Date().toISOString(), job('iw-known').url)
			.run();
		assert.equal(res.meta.changes, 1);
		assert.equal(
			res.meta.rows_written,
			1,
			'an index covering last_seen_at makes every scrape pay for it on every posting'
		);
	});
});
