import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob, scoreJobUpperBound, type ScoringProfile } from '../src/scoring.ts';

/** The owner's profile shape, as seeded 2026-08-19. */
const OWNER: ScoringProfile = {
	keywords: ['ai', 'ml', 'platform', 'backend', 'software engineer', 'distributed systems'],
	levels: ['senior', 'staff', 'principal', 'manager'],
	remote_pref: 'remote',
	stack: [
		'python',
		'typescript',
		'javascript',
		'react',
		'c#',
		'.net',
		'c++',
		'sql',
		'rust',
		'java',
		'node',
	],
	interests_like: [
		'generative ai',
		'diffusion',
		'llm',
		'fine-tuning',
		'model evaluation',
		'ai agents',
		'game',
		'video game',
		'graphics',
	],
	interests_avoid: [
		'ads',
		'advertising',
		'adtech',
		'payments',
		'recoveries',
		'collections',
		'prediction market',
		'gambling',
		'insurance',
		'compliance',
		'kyc',
	],
	salary_floor: 350000,
};

function job(over: Partial<Parameters<typeof scoreJob>[0]> = {}) {
	return {
		title: 'Staff Software Engineer, AI Platform',
		description: 'Build ml backend systems for distributed systems at scale.',
		location: 'Remote - US',
		workplace_type: 'remote',
		salary_max: null,
		role_level: 'staff' as const,
		...over,
	};
}

// ── golden set: the owner's five complaints, as permanent regressions ────────

test('golden #1: published lowball pay sinks (delinea case)', () => {
	const lowball = scoreJob(job({ salary_max: 180000 }), OWNER);
	const unpublished = scoreJob(job({ salary_max: null }), OWNER);
	assert.ok(lowball.score < 0.25, `lowball must sink, got ${lowball.score}`);
	assert.ok(unpublished.score > lowball.score * 3, 'unpublished salary stays neutral');
	const atFloor = scoreJob(job({ salary_max: 400000 }), OWNER);
	assert.ok(atFloor.score > unpublished.score, 'above-floor published beats neutral');
	// Owner calibration (scratch #9): posted ranges are BASE, the 350k floor is
	// TOTAL comp — a ~250k base ≈ target once equity is counted, so it must
	// score ABOVE neutral, not below.
	const baseFine = scoreJob(job({ salary_max: 250000 }), OWNER);
	assert.ok(
		baseFine.breakdown.comp_fit >= 0.85,
		`250k base ≈ 350k total must score well, got ${baseFine.breakdown.comp_fit}`
	);
	const nvidia = scoreJob(job({ salary_max: 431250 }), OWNER);
	assert.ok(nvidia.breakdown.comp_fit >= 0.9, 'NVIDIA 431k base is a clear pass');
});

test('golden #2: non-Americas remote sinks (affirm Remote Spain / Poland)', () => {
	const spain = scoreJob(job({ location: 'Remote Spain' }), OWNER);
	const poland = scoreJob(job({ location: 'Remote Poland' }), OWNER);
	const us = scoreJob(job({ location: 'U.S. Remote' }), OWNER);
	assert.ok(
		spain.score <= us.score * 0.15,
		`Remote Spain must sink: ${spain.score} vs ${us.score}`
	);
	assert.ok(poland.score <= us.score * 0.15);
	// Americas timezones are fine for US hours.
	const canada = scoreJob(job({ location: 'Remote - Canada' }), OWNER);
	assert.ok(canada.score > spain.score * 3);
});

test('golden #3: title-named foreign stack ranks below stack-neutral (Ruby/Rails case)', () => {
	const rails = scoreJob(
		job({
			title: 'Senior Software Engineer - Business Platform (Ruby/Rails)',
			role_level: 'senior',
		}),
		OWNER
	);
	const neutral = scoreJob(
		job({ title: 'Senior Software Engineer - Business Platform', role_level: 'senior' }),
		OWNER
	);
	assert.ok(rails.score < neutral.score, `${rails.score} !< ${neutral.score}`);
	assert.equal(rails.breakdown.stack_fit, 0.2, 'ruby AND rails both foreign');
	// A stack the owner has doesn't penalize.
	const py = scoreJob(
		job({ title: 'Senior Software Engineer - Python Platform', role_level: 'senior' }),
		OWNER
	);
	assert.equal(py.breakdown.stack_fit, 1.0);
});

test('golden #4: interesting domains outrank boring ones at equal relevance', () => {
	const genai = scoreJob(job({ title: 'Staff Software Engineer, Generative AI Video' }), OWNER);
	const ads = scoreJob(job({ title: 'Staff Software Engineer, Ads Platform' }), OWNER);
	const neutralDomain = scoreJob(job({ title: 'Staff Software Engineer, Internal Tools' }), OWNER);
	assert.ok(genai.score > neutralDomain.score, 'liked domain boosts');
	assert.ok(ads.score < neutralDomain.score, 'avoided domain drags');
	assert.ok(genai.score > ads.score);
	// soft, not exclusion: the ads job still has a real score
	assert.ok(ads.score > 0.3);
});

test('golden #5: no saturation — strong matches spread below 1.0', () => {
	const scores = [
		job({}),
		job({ title: 'Senior Backend Engineer, ML Platform', role_level: 'senior' }),
		job({ title: 'Staff Software Engineer - AI - Platform Integrations' }),
		job({ title: 'Principal Software Engineer, Distributed Systems', role_level: 'principal' }),
	].map((j) => scoreJob(j, OWNER).score);
	for (const s of scores) assert.ok(s < 1.0, `no job should hit a perfect 1.0, got ${s}`);
	assert.ok(new Set(scores).size >= 3, `scores must spread, got ${scores.join(', ')}`);
});

// ── carried-over guarantees from v1 ──────────────────────────────────────────

test('level_match still grades by ladder distance', () => {
	const at = (lvl: 'principal' | 'staff' | 'senior' | 'junior' | 'fellow') =>
		scoreJob(job({ role_level: lvl }), { ...OWNER, levels: ['principal'] }).breakdown.level_match;
	assert.equal(at('principal'), 1.0);
	assert.equal(at('staff'), 0.7);
	assert.equal(at('fellow'), 0.7);
	assert.equal(at('senior'), 0.2);
	assert.equal(at('junior'), 0.2);
});

test('keywords still match whole words only ("ai" ≠ "GenAI"/"maintain")', () => {
	const noise = scoreJob(
		job({
			title: 'Staff Product Manager, ML Foundations and GenAI',
			description: 'You will maintain available roadmaps daily.',
		}),
		{ ...OWNER, keywords: ['ai'] }
	);
	assert.equal(noise.breakdown.relevance, 0, '"ai" must not match inside GenAI/maintain');
});

test('adjacent-ladder titles still multiplied down', () => {
	const pm = scoreJob(job({ title: 'Staff Product Manager, ML Foundations' }), OWNER);
	assert.equal(pm.breakdown.discipline_factor, 0.15);
	const eng = scoreJob(job({}), OWNER);
	assert.ok(eng.score > pm.score * 3);
});

test('neutral profile (no prefs) scores everything mid-range, nothing throws', () => {
	const neutral: ScoringProfile = {
		keywords: [],
		levels: [],
		remote_pref: 'any',
		stack: [],
		interests_like: [],
		interests_avoid: [],
		salary_floor: null,
	};
	const r = scoreJob(job({}), neutral);
	assert.ok(r.score > 0.3 && r.score < 0.7, `neutral should be mid-range, got ${r.score}`);
});

test('scoreJobUpperBound is a true upper bound on the full score', () => {
	const jobs = [
		job({}),
		job({
			title: 'Senior Software Engineer - Business Platform (Ruby/Rails)',
			role_level: 'senior',
		}),
		job({ title: 'Staff Software Engineer, Ads Platform', salary_max: 180000 }),
		job({ location: 'Remote Spain', description: 'generative ai diffusion llm work' }),
		job({ title: 'Staff Product Manager, GenAI', description: 'ads platform' }),
	];
	for (const j of jobs) {
		const full = scoreJob(j, OWNER).score;
		const bound = scoreJobUpperBound(j, OWNER);
		assert.ok(bound >= full, `bound ${bound} < full ${full} for "${j.title}" @ ${j.location}`);
	}
});
