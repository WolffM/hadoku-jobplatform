import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criteriaHash } from '../src/rank.ts';
import type { ScorableProfile } from '../src/profileScore.ts';

const ENGINEER: ScorableProfile = {
	keywords: ['backend', 'distributed systems'],
	track: 'either',
	levels: ['senior'],
	remote_pref: 'remote',
	stack: ['python'],
	interests_like: [],
	interests_avoid: [],
	salary_floor: null,
	location: null,
};

test('criteriaHash is unchanged for profiles the derived inputs do not affect', () => {
	// The exact string every pre-existing ranking was stored under.
	assert.equal(
		criteriaHash(ENGINEER),
		JSON.stringify([
			['backend', 'distributed systems'],
			'either',
			['senior'],
			'remote',
			['python'],
			[],
			[],
			null,
		])
	);
	assert.equal(criteriaHash({ ...ENGINEER, location: 'seattle-wa' }), criteriaHash(ENGINEER));
});

test('criteriaHash changes with the home region, not the raw location', () => {
	const berlin = criteriaHash({ ...ENGINEER, location: 'berlin-de' });
	assert.notEqual(berlin, criteriaHash(ENGINEER));
	assert.equal(criteriaHash({ ...ENGINEER, location: 'munich-de' }), berlin);
	assert.notEqual(criteriaHash({ ...ENGINEER, location: 'tokyo-jp' }), berlin);
});

test('criteriaHash changes when keywords start naming an adjacent ladder', () => {
	const pm = { ...ENGINEER, keywords: ['project manager'] };
	const plain = JSON.stringify([
		['project manager'],
		'either',
		['senior'],
		'remote',
		['python'],
		[],
		[],
		null,
	]);
	assert.notEqual(criteriaHash(pm), plain, 'a ranking built before the waiver must be rebuilt');
});
