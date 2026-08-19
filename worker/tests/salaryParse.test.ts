import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalaryRange } from '../src/salaryParse.ts';

test('parses the NVIDIA pay-transparency phrasing (owner scratch #8)', () => {
	const r = parseSalaryRange('The base salary range is 272,000 USD - 431,250 USD.');
	assert.deepEqual(r, { min: 272000, max: 431250 });
});

test('parses $-prefixed ranges and k-notation', () => {
	assert.deepEqual(parseSalaryRange('Pay: $150,000 - $200,000 plus equity'), {
		min: 150000,
		max: 200000,
	});
	assert.deepEqual(parseSalaryRange('comp of $150k to $210K annually'), {
		min: 150000,
		max: 210000,
	});
});

test('multiple location-tiered ranges collapse to overall min/max', () => {
	const r = parseSalaryRange(
		'CO: $180,000 - $220,000. In NYC and CA the range is $210,000 - $260,000.'
	);
	assert.deepEqual(r, { min: 180000, max: 260000 });
});

test('skips hourly/monthly amounts and unmarked numbers', () => {
	assert.equal(parseSalaryRange('pay of $55 - $75 per hour'), null);
	assert.equal(parseSalaryRange('rate: $8,000 - $12,000 per month'), null);
	assert.equal(parseSalaryRange('manage 13,000 - 15,000 repositories'), null);
	assert.equal(parseSalaryRange('grew revenue from 150,000 to 200,000 users'), null);
});

test('rejects non-annual magnitudes and inverted ranges', () => {
	assert.equal(parseSalaryRange('$5,000 - $10,000 signing bonus'), null);
	assert.equal(parseSalaryRange('$300,000 - $250,000'), null);
});
