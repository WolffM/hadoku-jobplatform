import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	disciplineFactor,
	homeRegion,
	scoreJob,
	scoreJobUpperBound,
	type ScoringProfile,
} from '../src/scoring.ts';

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
	// Even 200k base is acceptable (scratch #13): at least neutral, and the
	// curve is strictly monotonic above it.
	const base200 = scoreJob(job({ salary_max: 200000 }), OWNER);
	assert.ok(
		base200.breakdown.comp_fit >= 0.5,
		`200k base must be >= neutral, got ${base200.breakdown.comp_fit}`
	);
	const baseFine = scoreJob(job({ salary_max: 250000 }), OWNER);
	assert.ok(baseFine.breakdown.comp_fit > base200.breakdown.comp_fit, 'higher base weighs higher');
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

// ── profile-relative geo and discipline ──────────────────────────────────────

/** A Berlin-based project/program manager: the case the US-only sinks buried. */
const BERLIN_PM: ScoringProfile = {
	keywords: ['project manager', 'program manager', 'technical project manager'],
	levels: ['senior', 'mid'],
	remote_pref: 'hybrid',
	stack: [],
	interests_like: [],
	interests_avoid: [],
	salary_floor: null,
	location: 'berlin-de',
};

function pmJob(over: Partial<Parameters<typeof scoreJob>[0]> = {}) {
	return {
		title: 'Technical Project Manager (Cloud Platform)',
		description: 'Own delivery plans across teams as the project manager for the platform.',
		location: 'Berlin, Germany; Amsterdam, Netherlands; Munich, Germany',
		workplace_type: 'hybrid',
		salary_max: null,
		role_level: null,
		...over,
	};
}

test('homeRegion resolves place keys, place names and country text', () => {
	assert.equal(homeRegion('berlin-de'), 'emea');
	assert.equal(homeRegion('Munich'), 'emea');
	assert.equal(homeRegion('Germany'), 'emea');
	assert.equal(homeRegion('tokyo-jp'), 'apac');
	assert.equal(homeRegion('seattle-wa'), 'americas');
	assert.equal(homeRegion('toronto-ca-on'), 'americas');
	// Illinois shares 'il' with Israel; a US place must stay in the Americas.
	assert.equal(homeRegion('chicago-il'), 'americas');
	assert.equal(homeRegion('tel-aviv-il'), 'emea');
	assert.equal(homeRegion(null), 'americas');
	assert.equal(homeRegion(undefined), 'americas');
	assert.equal(homeRegion('   '), 'americas');
	assert.equal(homeRegion('somewhere unknown'), 'americas');
});

test('a Berlin profile does not sink postings in Germany/Europe', () => {
	const r = scoreJob(pmJob(), BERLIN_PM);
	assert.equal(r.breakdown.geo_fit, 1.0, 'hybrid in a named home-region country fits cleanly');
	const eu = scoreJob(pmJob({ location: 'Remote - Europe' }), BERLIN_PM);
	assert.ok(eu.breakdown.geo_fit > 0.1, `Europe is home, got geo_fit ${eu.breakdown.geo_fit}`);
});

test('a Berlin profile sinks postings that name only another region', () => {
	const home = scoreJob(pmJob({ location: 'Berlin, Germany' }), BERLIN_PM);
	const us = scoreJob(pmJob({ location: 'Remote - US' }), BERLIN_PM);
	const india = scoreJob(pmJob({ location: 'Bengaluru, India' }), BERLIN_PM);
	assert.ok(us.score <= home.score * 0.15, `US-only must sink: ${us.score} vs ${home.score}`);
	assert.ok(india.score <= home.score * 0.15, `APAC must sink: ${india.score} vs ${home.score}`);
	// A posting open to both regions names home, so it is not out-of-region.
	const both = scoreJob(pmJob({ location: 'Remote - US or Europe' }), BERLIN_PM);
	assert.ok(both.score > us.score * 3);
});

test('the default home region scores exactly as before location was read', () => {
	const locations = [
		'Remote - US',
		'U.S. Remote',
		'Remote Spain',
		'Remote Poland',
		'Remote - Canada',
		'Berlin, Germany',
		'Berlin',
		'London, UK',
		'Bengaluru, India',
		'EMEA',
		'San Francisco, CA',
		'Remote',
		'',
	];
	for (const homeless of [undefined, null, '', 'seattle-wa', 'not a place']) {
		for (const location of locations) {
			const j = job({ location });
			const before = scoreJob(j, OWNER);
			const after = scoreJob(j, { ...OWNER, location: homeless });
			assert.deepEqual(after, before, `${String(homeless)} @ "${location}"`);
			assert.equal(
				scoreJobUpperBound(j, { ...OWNER, location: homeless }),
				scoreJobUpperBound(j, OWNER)
			);
		}
	}
});

test('a profile that names an adjacent ladder is not sunk for that ladder', () => {
	const tpm = scoreJob(pmJob(), BERLIN_PM);
	assert.equal(tpm.breakdown.discipline_factor, 1.0);
	const program = scoreJob(
		pmJob({ title: 'Senior Technical Program Manager (IDE Department)', role_level: 'senior' }),
		BERLIN_PM
	);
	assert.equal(program.breakdown.discipline_factor, 1.0);
	// The motivating case: relevance 0.75 used to end at a final score of 0.006.
	assert.ok(tpm.score > 0.4, `a matching Berlin TPM role must rank, got ${tpm.score}`);
});

test('the waiver covers only the ladder the keywords name', () => {
	assert.equal(disciplineFactor('Senior Sales Manager, DACH', BERLIN_PM.keywords), 0.15);
	assert.equal(disciplineFactor('Product Manager, Payments', BERLIN_PM.keywords), 0.15);
	assert.equal(disciplineFactor('Product Designer', BERLIN_PM.keywords), 0.15);
	assert.equal(disciplineFactor('Program Manager, Hardware', BERLIN_PM.keywords), 1.0);
	// Non-adjacent titles were never penalized and still are not.
	assert.equal(disciplineFactor('Operations Manager', BERLIN_PM.keywords), 1.0);
});

test('an engineering profile keeps the adjacent sink even when a keyword hits the title', () => {
	// "ml" is in the title, but "ml" is not an adjacent-ladder keyword.
	assert.equal(disciplineFactor('Staff Product Manager, ML Foundations', OWNER.keywords), 0.15);
	assert.equal(disciplineFactor('Technical Program Manager, AI Platform', OWNER.keywords), 0.15);
});

test('scoreJobUpperBound is a true upper bound for a non-default home region', () => {
	const jobs = [
		pmJob(),
		pmJob({ location: 'Remote - US' }),
		pmJob({ title: 'Senior Sales Manager', location: 'Berlin' }),
		pmJob({ title: 'Program Manager', description: 'nothing relevant here' }),
		pmJob({ location: 'Tokyo, Japan', workplace_type: 'onsite' }),
	];
	for (const j of jobs) {
		const full = scoreJob(j, BERLIN_PM).score;
		const bound = scoreJobUpperBound(j, BERLIN_PM);
		assert.ok(bound >= full, `bound ${bound} < full ${full} for "${j.title}" @ ${j.location}`);
	}
});
