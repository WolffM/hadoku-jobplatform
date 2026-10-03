import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOption as worker } from '../src/questionFamily.ts';
import { matchOption as dashboard } from '../../src/components/matchOption.ts';

/**
 * The dashboard's copy of matchOption must say exactly what the worker's does.
 *
 * The worker pre-fills each question's suggestion; the dashboard re-runs the
 * match when the owner types one answer and applies it to a whole family. If
 * they drifted, "Apply to all" would pick a different option than the
 * suggestion printed beside it — silently, on a real application.
 */
const CASES: [answer: string, options: string[]][] = [
	// Contractions are reachable ONLY through normalisation here: no yes/no lead
	// and no containment either way. The first version of this table had no such
	// case — a copy with contraction handling deleted still passed every row,
	// because "No, I do not…" also matches through the yes/no rule.
	['I do not wish to answer', ["I don't wish to answer", 'I wish to answer', 'Decline']],
	["I don't want to say", ['I do not want to say', 'Prefer to say']],
	[
		'No, I do not have a disability',
		['Yes, I have a disability', "No, I don't have a disability", "I don't wish to answer"],
	],
	['No', ['Yes', 'No', 'Decline to answer']],
	['no', ['No, never', 'No, but I applied before', 'Yes']],
	['yes', ['Yes, no restriction.', 'No']],
	['LinkedIn', ['LinkedIn (Datadog Page)', 'LinkedIn (Job Posting)', 'Indeed']],
	['LinkedIn', ['LinkedIn', 'Indeed']],
	['White', ['Asian', 'White', "I don't wish to answer"]],
	['Male', ['Female', 'Non-binary']],
	['Microsoft Corporation', []],
	// Chime's two Country menus, and a territory that must never be the US
	['USA', ['United States +1', 'United Arab Emirates +971', 'United Kingdom +44']],
	['U.S.A.', ['United States of America', 'United Arab Emirates', 'United Kingdom']],
	['USA', ['United States', 'United States Minor Outlying Islands', 'Canada']],
	['   ', ['Yes', 'No']],
	[
		'I am not a protected veteran',
		[
			'I identify as one or more of the protected veteran classes',
			'I am not a protected veteran',
			"I don't wish to answer",
		],
	],
	['Seattle', ['Remote', 'Seattle, WA', 'New York, NY']],
];

for (const [answer, options] of CASES) {
	test(`same answer from both copies: ${JSON.stringify(answer)} vs ${options.length} options`, () => {
		assert.equal(dashboard(answer, options), worker(answer, options));
	});
}
