import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRole } from '../src/roleClassify.ts';

/**
 * Regression cases for the role classifier.
 *
 * Every entry below is either a convention worth pinning or a real
 * misclassification found by running the classifier over 800 live corpus titles
 * (hadoku.me/jobplatform/api/jobs). The false positives are the point: a wrong
 * `track` makes a job invisible, because track is a hard filter.
 *
 * Run with `pnpm test` (node strips the types natively — no test framework).
 */

const CASES: [title: string, track: string, level: string | null][] = [
	// ── the IC ladder ────────────────────────────────────────────────────────
	['Software Engineer', 'ic', null],
	['Senior Software Engineer', 'ic', 'senior'],
	['Sr. Software Engineer', 'ic', 'senior'],
	['Staff Software Engineer', 'ic', 'staff'],
	// Most-senior rung wins, so this is staff and not senior.
	['Senior Staff Software Engineer', 'ic', 'staff'],
	['Principal Engineer', 'ic', 'principal'],
	['Distinguished Engineer', 'ic', 'fellow'],
	['Software Engineer II', 'ic', 'mid'],
	['New Grad Software Engineer', 'ic', 'junior'],

	// ── the manager ladder ───────────────────────────────────────────────────
	['Engineering Manager, Model Flywheel', 'manager', 'manager'],
	['Senior Manager, Data Platform', 'manager', 'senior_manager'],
	['Director of Engineering', 'manager', 'director'],
	['Head of Engineering', 'manager', 'vp'],
	['VP Strategic Finance', 'manager', 'vp'],
	['Chief Technology Officer', 'manager', 'cxo'],
	['CTO', 'manager', 'cxo'],
	// Google's TLM really does carry reports, and beats the Tech Lead convention.
	['Tech Lead Manager - Lakebase', 'manager', 'manager'],

	// ── management words on IC roles (the big trap) ──────────────────────────
	['Technical Program Manager', 'ic', null],
	['Senior Product Manager', 'ic', 'senior'],
	// A product name in the tail must not flip the track.
	['Software Engineer, Ads Manager', 'ic', null],
	// Sales/partnership ladders, not orgs — ~17% of the first pass's "managers".
	['Account Director, Retail', 'ic', null],
	['Partner Director, India', 'ic', null],
	['Non Executive Director', 'ic', null],
	// The C-level token names the org supported, not the role.
	['Visual Storytelling & AI Innovation Lead, Office of the CFO', 'ic', null],
	// Base IC title at the AI labs — not a staff-level rung.
	['Member of Technical Staff', 'ic', null],
	['Member of Technical Staff, Inference', 'ic', null],
	['Chief of Staff', 'ic', null],
];

for (const [title, track, level] of CASES) {
	test(`classifies "${title}"`, () => {
		const r = classifyRole(title, '');
		assert.equal(r.track, track);
		assert.equal(r.level, level);
	});
}

// ── the ambiguous "lead" family resolves from the description ───────────────

test('"Lead" with people-management signals in the body is a manager', () => {
	const r = classifyRole(
		'Engineering Lead, Payments',
		'You will have 6 direct reports and own performance reviews.'
	);
	assert.equal(r.track, 'manager');
});

test('"Lead" without those signals stays IC', () => {
	const r = classifyRole(
		'Engineering Lead, Payments',
		'You will write code and mentor peers on the platform team.'
	);
	assert.equal(r.track, 'ic');
});

test('"Tech Lead" is IC by convention and skips the body probe', () => {
	// Deliberate: track is a hard filter, so precision beats recall here. Senior
	// IC postings routinely discuss working with managers and their reports, and
	// a stray phrase must not make the job invisible to an IC search.
	const r = classifyRole('Tech Lead, Payments', 'You will have 6 direct reports.');
	assert.equal(r.track, 'ic');
});

test('a blank title is the only thing that stays unknown', () => {
	assert.equal(classifyRole('', '').track, 'unknown');
	assert.equal(classifyRole('   ', 'some body').track, 'unknown');
});
