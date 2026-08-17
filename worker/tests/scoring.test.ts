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
		'discipline_factor',
		'keyword_match',
		'level_match',
		'remote_match',
		'title_match',
	]);
});

test('keywords match whole words only — "ai" no longer matches "maintain" or "GenAI"', () => {
	// The substring matcher let the keyword "ai" hit essentially every posting;
	// combined with the title clamp it put a Staff Product Manager at 1.000.
	const noise = {
		title: 'Staff Product Manager, ML Foundations and GenAI',
		description: 'You will maintain available roadmaps daily.',
		workplace_type: 'remote',
		role_level: 'staff' as const,
	};
	const r = scoreJob(noise, { keywords: ['ai'], levels: [], remote_pref: 'remote' });
	assert.equal(r.breakdown.title_match, 0, '"ai" must not match inside "GenAI"');
	assert.equal(r.breakdown.keyword_match, 0, '"ai" must not match inside "maintain"/"available"');

	const real = { ...noise, title: 'AI Platform Engineer', description: 'Build AI systems.' };
	const r2 = scoreJob(real, { keywords: ['ai'], levels: [], remote_pref: 'remote' });
	assert.equal(r2.breakdown.title_match, 1, 'standalone "AI" still matches');
	assert.equal(r2.breakdown.keyword_match, 1);
});

test('multi-word keywords still match on word boundaries', () => {
	const j = {
		title: 'Software Engineer',
		description: 'We build distributed systems at scale.',
		workplace_type: 'remote',
		role_level: null,
	};
	const r = scoreJob(j, {
		keywords: ['software engineer', 'distributed systems'],
		levels: [],
		remote_pref: 'remote',
	});
	assert.equal(r.breakdown.title_match, 1);
	assert.equal(r.breakdown.keyword_match, 1);
});

test('adjacent-ladder titles are multiplied down, not hidden', () => {
	const pm = {
		title: 'Staff Product Manager, ML Foundations and GenAI',
		description: 'ai platform',
		workplace_type: 'remote',
		role_level: 'staff' as const,
	};
	const eng = { ...pm, title: 'Staff Software Engineer, ML Foundations' };
	const profile = {
		keywords: ['ai', 'platform'],
		levels: ['staff'] as const,
		remote_pref: 'remote',
	};

	const pmScore = scoreJob(pm, profile);
	const engScore = scoreJob(eng, profile);
	assert.equal(pmScore.breakdown.discipline_factor, 0.15);
	assert.equal(engScore.breakdown.discipline_factor, 1.0);
	assert.ok(pmScore.score < 0.2, `a PM must not top an SWE feed (got ${pmScore.score})`);
	assert.ok(engScore.score > pmScore.score * 4);
});

test('engineering-signal titles are never discipline-penalized', () => {
	for (const title of ['Engineering Manager', 'Product Engineer', 'Site Reliability Engineer']) {
		const r = scoreJob(
			{ title, description: 'ai platform', workplace_type: 'remote', role_level: null },
			{ keywords: ['ai', 'platform'], levels: [], remote_pref: 'remote' }
		);
		assert.equal(r.breakdown.discipline_factor, 1.0, title);
	}
});
