import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode } from '../src/verificationCode.ts';

test('a code alone between asterisk rows (MyGreenhouse)', () => {
	const body =
		'Greenhouse\r\n\r\nHi,\r\n\r\nYour security code is:\r\n\r\n********\r\nz2iufgvn\r\n********\r\n\r\nEnter this code';
	assert.equal(extractCode(body), 'z2iufgvn');
});

test('a code after "code:" on the same line', () => {
	assert.equal(extractCode('Your security code: Ab3dE9xQ. It expires soon.'), 'Ab3dE9xQ');
});

test('a code alone on the line after the sentence that mentions it', () => {
	assert.equal(
		extractCode('Copy and paste this code into the security code field:\n\nAb3dE9xQ\n\nGreenhouse'),
		'Ab3dE9xQ'
	);
});

test('no code is invented from a signature or a plain word', () => {
	assert.equal(extractCode('Thanks for your interest.\n\nGreenhouse'), null);
	assert.equal(extractCode('Enter the code from your email.\n\nApplication'), null);
});
