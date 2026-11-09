/**
 * Migration 0031: profiles pointed at boards that 404 are moved to where the
 * company posts now, or dropped — and the scrape directive follows.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, createHarness, splitStatements, type Harness } from '../helpers/harness.ts';
import { seedProfile } from '../helpers/seed.ts';

const MIGRATION = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'migrations',
	'0031_retarget_dead_boards.sql'
);

let h: Harness;

async function company(profileId: string, ats: string, slug: string) {
	await h.db
		.prepare(
			`INSERT INTO profile_companies (id, profile_id, ats, slug, display_name, target_id, added_at)
			 VALUES (?, ?, ?, ?, ?, NULL, '2026-09-07T00:00:00Z')`
		)
		.bind(crypto.randomUUID(), profileId, ats, slug, slug)
		.run();
}

const pairs = async (profileId: string) =>
	(
		await h.db
			.prepare(
				"SELECT ats || ':' || slug AS pair FROM profile_companies WHERE profile_id = ? ORDER BY pair"
			)
			.bind(profileId)
			.all<{ pair: string }>()
	).results.map((r) => r.pair);

before(async () => {
	h = await createHarness();
	await seedProfile(h.db, { id: 'seeded', user_id: 'u1', keywords: ['engineer'] });
	await seedProfile(h.db, { id: 'already', user_id: 'u2', keywords: ['engineer'] });
	await seedProfile(h.db, { id: 'discovery', user_id: 'u3', keywords: ['engineer'] });
	for (const [ats, slug] of [
		['greenhouse', 'anthropic'],
		['lever', 'anyscale'],
		['lever', 'mistral'],
		['lever', 'plaid'],
	])
		await company('seeded', ats, slug);
	// Already lists the live board: the dead row must go, not collide.
	await company('already', 'ashby', 'anyscale');
	await company('already', 'lever', 'anyscale');
	for (const [ats, slug] of [
		['greenhouse', 'withwaymo'],
		['greenhouse', 'datadoghq'],
		['greenhouse', 'pinterestcareers'],
		['greenhouse', 'toasttab'],
		['greenhouse', 'linkedin'],
		['greenhouse', 'gigaenergy'],
		['greenhouse', 'postman'],
		['greenhouse', 'realm'],
		['ashby', 'ocean'],
	])
		await company('discovery', ats, slug);
	// Applied once already by the harness (to empty tables); this is the run
	// production gets, over real rows.
	for (const stmt of splitStatements(readFileSync(MIGRATION, 'utf8')))
		await h.db.prepare(stmt).run();
});

after(async () => {
	await h.dispose();
});

describe('0031_retarget_dead_boards', () => {
	it('moves the default seeds to Ashby, drops Mistral, and keeps the rest', async () => {
		assert.deepEqual(await pairs('seeded'), [
			'ashby:anyscale',
			'ashby:plaid',
			'greenhouse:anthropic',
		]);
	});

	it('leaves one row when the profile already had the live board', async () => {
		assert.deepEqual(await pairs('already'), ['ashby:anyscale']);
	});

	it('retargets the hostname guesses and moved boards, and drops the unfindable', async () => {
		assert.deepEqual(await pairs('discovery'), [
			'ashby:giga-energy',
			'greenhouse:datadog',
			'greenhouse:pinterest',
			'greenhouse:toast',
			'greenhouse:waymo',
			'lever:linkedin',
		]);
	});

	it('so the scrape directive names no dead board', async () => {
		const res = await h.json<{ data: { companies: { ats: string; slug: string }[] } }>(
			`${BASE}/directives`,
			{ tier: 'service', userId: 'the-service' }
		);
		const names = res.body.data.companies.map((c) => `${c.ats}:${c.slug}`);
		for (const dead of ['lever:anyscale', 'lever:mistral', 'greenhouse:withwaymo', 'ashby:ocean'])
			assert.ok(!names.includes(dead), `${dead} is still a directive`);
		assert.ok(names.includes('ashby:plaid') && names.includes('greenhouse:datadog'));
	});
});
