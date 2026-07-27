import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob } from '../src/scoring.ts';

/** A job that matches every keyword and the remote preference. */
function job(roleLevel: Parameters<typeof scoreJob>[0]['role_level']) {
	return {
		title: 'ai platform',
		description: 'ai platform',
		workplace_type: 'remote',
		role_level: roleLevel,
	};
}

const wantsPrincipal = {
	keywords: ['ai', 'platform'],
	levels: ['principal'] as const,
	remote_pref: 'remote',
};

test('weights sum to 1.0 — a perfect match scores 1.0', () => {
	const r = scoreJob(job('principal'), { ...wantsPrincipal, levels: ['principal'] });
	assert.equal(r.score, 1);
});

test('level_match grades by distance on the ladder', () => {
	const at = (lvl: Parameters<typeof job>[0]) =>
		scoreJob(job(lvl), { ...wantsPrincipal, levels: ['principal'] }).breakdown.level_match;

	assert.equal(at('principal'), 1.0, 'exact rung');
	assert.equal(at('staff'), 0.7, 'one rung below');
	assert.equal(at('fellow'), 0.7, 'one rung above');
	assert.equal(at('senior'), 0.2, 'two rungs off');
	assert.equal(at('junior'), 0.2, 'far off');
	// The old scorer returned a flat 0.4 for every miss, so Junior and VP were
	// penalized identically. Distance is the whole point of the rewrite.
	assert.ok(at('staff') > at('senior'));
});

test('rungs on the other ladder are not "near" — they are a different job', () => {
	const r = scoreJob(job('director'), { ...wantsPrincipal, levels: ['principal'] });
	assert.equal(r.breakdown.level_match, 0.2);
});

test('an unclassified job is neutral, not a miss', () => {
	// The old scorer punished a plain "Software Engineer" for having no modifier.
	const r = scoreJob(job(null), { ...wantsPrincipal, levels: ['principal'] });
	assert.equal(r.breakdown.level_match, 0.5);
});

test('a profile with no levels expresses no constraint', () => {
	for (const lvl of ['junior', 'principal', 'cxo'] as const) {
		const r = scoreJob(job(lvl), { ...wantsPrincipal, levels: [] });
		assert.equal(r.breakdown.level_match, 0.5);
	}
});

test('salary is gone from the breakdown entirely', () => {
	const r = scoreJob(job('principal'), { ...wantsPrincipal, levels: ['principal'] });
	assert.deepEqual(Object.keys(r.breakdown).sort(), [
		'keyword_match',
		'level_match',
		'remote_match',
		'title_match',
	]);
});
