/**
 * GET /directives: the companies and keywords every profile asked for, and
 * `places`, each profile's resolved home place with its radius and keywords.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedProfile, seedProfileCompany } from '../helpers/seed.ts';
import { directivePlaces } from '../../src/directivePlaces.ts';

interface Directives {
	companies: { ats: string; slug: string }[];
	keywords: string[];
	places: { name: string; country: string; radius_miles: number; keywords: string[] }[];
}

let h: Harness;

async function setPlace(id: string, location: string | null, radius = 25) {
	await h.db
		.prepare('UPDATE profiles SET location = ?, radius_miles = ? WHERE id = ?')
		.bind(location, radius, id)
		.run();
}

before(async () => {
	h = await createHarness();
	await seedProfile(h.db, { id: 'berlin-pm', user_id: 'u1', keywords: ['Project Manager', 'TPM'] });
	await seedProfile(h.db, { id: 'berlin-ops', user_id: 'u2', keywords: ['tpm', 'Operations'] });
	await seedProfile(h.db, { id: 'munich', user_id: 'u3', keywords: ['Projektleiter'] });
	await seedProfile(h.db, { id: 'seattle', user_id: 'u4', keywords: ['engineer'] });
	await seedProfile(h.db, { id: 'nowhere', user_id: 'u5', keywords: ['designer'] });
	await seedProfile(h.db, { id: 'no-keywords', user_id: 'u6', keywords: [] });
	await setPlace('berlin-pm', 'berlin-de');
	await setPlace('berlin-ops', 'Berlin, Germany');
	await setPlace('munich', 'munich-de', 40);
	await setPlace('seattle', 'seattle-wa', 10);
	await setPlace('nowhere', 'Atlantis');
	await setPlace('no-keywords', 'berlin-de');
	await seedProfileCompany(h.db, {
		id: 'c1',
		profile_id: 'berlin-pm',
		ats: 'personio',
		slug: 'example-gmbh',
	});
	await seedProfileCompany(h.db, {
		id: 'c2',
		profile_id: 'seattle',
		ats: 'greenhouse',
		slug: 'acme',
	});
});

after(async () => {
	await h.dispose();
});

describe('GET /directives', () => {
	it('keeps companies (every ATS) and the keyword union as before', async () => {
		const res = await h.json<{ data: Directives }>(`${BASE}/directives`, {
			tier: 'service',
			userId: 'the-service',
		});
		assert.equal(res.status, 200);
		assert.deepEqual(res.body.data.companies, [
			{ ats: 'greenhouse', slug: 'acme' },
			{ ats: 'personio', slug: 'example-gmbh' },
		]);
		assert.deepEqual(res.body.data.keywords, [
			'Project Manager',
			'TPM',
			'Operations',
			'Projektleiter',
			'engineer',
			'designer',
		]);
	});

	it("lists each profile's resolved place, radius and keywords, merged per place", async () => {
		const res = await h.json<{ data: Directives }>(`${BASE}/directives`, {
			tier: 'service',
			userId: 'the-service',
		});
		assert.deepEqual(res.body.data.places, [
			{
				name: 'Berlin',
				country: 'de',
				radius_miles: 25,
				keywords: ['Project Manager', 'TPM', 'Operations'],
			},
			{ name: 'Munich', country: 'de', radius_miles: 40, keywords: ['Projektleiter'] },
			{ name: 'Seattle', country: 'us', radius_miles: 10, keywords: ['engineer'] },
		]);
	});

	it('is friend tier and up', async () => {
		const res = await h.fetch(`${BASE}/directives`, { tier: 'public' });
		assert.equal(res.status, 403);
	});
});

describe('directivePlaces', () => {
	it('keeps separate radii at one place apart', () => {
		const places = directivePlaces([
			{ location: 'berlin-de', radius_miles: 40, keywords: '["a"]' },
			{ location: 'berlin-de', radius_miles: 10, keywords: '["b"]' },
		]);
		assert.deepEqual(
			places.map((p) => [p.name, p.radius_miles, p.keywords]),
			[
				['Berlin', 10, ['b']],
				['Berlin', 40, ['a']],
			]
		);
	});

	it('reads the country, not the region code, and a missing radius as 25 miles', () => {
		// 'in' is Indiana as a region and India as a country.
		const places = directivePlaces([
			{ location: 'indianapolis-in', radius_miles: null, keywords: '["x"]' },
			{ location: 'bengaluru-in', radius_miles: null, keywords: '["x"]' },
			{ location: 'potsdam-de', radius_miles: null, keywords: '["y"]' },
		]);
		assert.deepEqual(
			places.map((p) => [p.name, p.country, p.radius_miles]),
			[
				['Bengaluru', 'in', 25],
				['Indianapolis', 'us', 25],
				['Potsdam', 'de', 25],
			]
		);
	});

	it('skips unreadable keywords and unknown or missing locations', () => {
		assert.deepEqual(
			directivePlaces([
				{ location: null, radius_miles: 25, keywords: '["a"]' },
				{ location: 'Atlantis', radius_miles: 25, keywords: '["a"]' },
				{ location: 'berlin-de', radius_miles: 25, keywords: 'not json' },
				{ location: 'berlin-de', radius_miles: 25, keywords: '{"a":1}' },
				{ location: 'berlin-de', radius_miles: 25, keywords: '["  ", 3]' },
			]),
			[]
		);
	});
});
