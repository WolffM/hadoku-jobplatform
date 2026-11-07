import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPlaces, geoKeys, placesWithin, resolvePlace, searchPlaces } from '../src/geo.ts';

const keys = (loc: string) => findPlaces(loc).map((p) => p.key);

// Every string here is a real `location` from the live corpus (2026-11-06)
// unless it says otherwise.
describe('findPlaces', () => {
	it('names every place in a multi-city string, and reads OR as Oregon', () => {
		assert.deepEqual(
			keys(
				'San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States'
			),
			['san-francisco-ca', 'new-york-ny', 'portland-or']
		);
		assert.deepEqual(keys('San Francisco, CA | New York City, NY'), [
			'san-francisco-ca',
			'new-york-ny',
		]);
	});

	it('reads codes and countries in any arrangement, and folds accents', () => {
		assert.deepEqual(keys('US-CA-Menlo Park'), ['menlo-park-ca']);
		assert.deepEqual(keys('Massachusetts - Boston'), ['boston-ma']);
		assert.deepEqual(keys('Sao Paulo, Sao Paulo, Brasil'), ['sao-paulo-br']);
		assert.deepEqual(keys('São Paulo'), ['sao-paulo-br'], 'constructed: the accented spelling');
		assert.deepEqual(keys('Toronto, Ontario, Canada'), ['toronto-ca-on']);
		assert.deepEqual(keys('Bangalore, India'), ['bengaluru-in']);
	});

	it('settles a shared name by the region the string names', () => {
		assert.deepEqual(keys('Cambridge, MA'), ['cambridge-ma']);
		assert.deepEqual(keys('Cambridge, UK'), ['cambridge-gb']);
		assert.deepEqual(keys('Arlington, TX'), ['arlington-tx']);
		assert.deepEqual(
			keys('Arlington'),
			['arlington-va'],
			'constructed: no evidence → first declared'
		);
		assert.deepEqual(keys('Dublin, Ireland'), ['dublin-ie']);
		assert.deepEqual(keys('Dublin, CA'), ['dublin-ca']);
		assert.deepEqual(keys('Dublin'), ['dublin-ie'], 'constructed: bare Dublin is Ireland');
	});

	it('does not read a state name as the city that shares it', () => {
		assert.deepEqual(keys('Seattle, Washington'), ['seattle-wa']);
		assert.deepEqual(keys('Washington, DC'), ['washington-dc']);
	});

	it('refuses the only place it knows by a name when the segment names another region', () => {
		// We know Hollywood, FL; "Hollywood, CA" is not it.
		assert.deepEqual(keys('Hollywood, CA'), [], 'constructed');
		assert.deepEqual(keys('Hollywood, FL'), ['hollywood-fl']);
	});

	it('reads evidence per segment, so one city does not lose its place to its neighbour', () => {
		assert.deepEqual(keys('San Francisco | Munich, Germany'), ['san-francisco-ca', 'munich-de']);
	});

	it('places nothing for remote, country-only and state-only strings', () => {
		for (const loc of ['Remote', 'Remote - USA', 'United States', 'Hybrid', 'Florida', 'Germany']) {
			assert.deepEqual(keys(loc), [], loc);
		}
	});

	it('does not read "New York City" as two places', () => {
		assert.deepEqual(keys('New York City'), ['new-york-ny']);
	});
});

describe('geoKeys', () => {
	it('is pipe-delimited for LIKE, and empty when nothing is placed', () => {
		assert.equal(geoKeys('Seattle, WA'), '|seattle-wa|');
		assert.equal(geoKeys('Remote'), '');
		assert.equal(geoKeys(''), '');
	});
});

describe('placesWithin / resolvePlace / searchPlaces', () => {
	it('finds the neighbours of a centre, nearest first, the centre included', () => {
		const sf = resolvePlace('san-francisco-ca')!;
		const near = placesWithin(sf, 15).map((p) => p.key);
		assert.equal(near[0], 'san-francisco-ca');
		assert.ok(near.includes('oakland-ca'));
		assert.ok(!near.includes('san-jose-ca'), 'San Jose is ~42 miles away');
	});

	it('resolves a key or free text, and null for an unknown place', () => {
		assert.equal(resolvePlace('seattle-wa')?.key, 'seattle-wa');
		assert.equal(resolvePlace('Seattle, WA')?.key, 'seattle-wa');
		assert.equal(resolvePlace('Atlantis'), null);
	});

	it('lists prefix matches before contains matches', () => {
		const found = searchPlaces('san').map((p) => p.key);
		assert.equal(found[0], 'san-marcos-tx');
		assert.ok(found.every((k) => k.startsWith('san')));
		assert.ok(searchPlaces('francisco').some((p) => p.key === 'san-francisco-ca'));
	});
});
