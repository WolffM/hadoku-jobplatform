import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companiesMatch, companyFromSubject, parseMail } from '../src/mailMatch.ts';

/**
 * Classifying ATS mail.
 *
 * Every subject marked LIVE below is verbatim from the mail feed on
 * 2026-09-19 — the full set of 7 messages the grant then covered. They are the
 * cases that matter most, because the feature's first version was written
 * against guesses about this wording and the guesses were wrong.
 *
 * The single most important assertion in this file is that a Greenhouse
 * security code is NOT a confirmation. Greenhouse has never sent this mailbox a
 * confirmation, all 37 applications are Greenhouse, and reading a code as a
 * confirmation would mark an application successfully received at the exact
 * moment it is blocked pending a human.
 */

test('a Greenhouse security code is a verification, never a confirmation', () => {
	// LIVE, 2026-09-16 — the mail that answers whether the Coinbase submits went
	// through. They did not.
	const parsed = parseMail(
		'Security code for your application to Coinbase',
		'us.greenhouse-mail.io'
	);
	assert.equal(parsed.kind, 'verification');
	assert.equal(parsed.company, 'coinbase');
});

test('a code subject containing "application" does not read as a confirmation', () => {
	// The ordering guard in parseMail. If confirmations were matched first this
	// would come back 'confirmation' — the most misleading answer available.
	const parsed = parseMail(
		'Security code for your application to Airtable', // LIVE, 2026-08-25
		'us.greenhouse-mail.io'
	);
	assert.equal(parsed.kind, 'verification');
	assert.equal(parsed.company, 'airtable');
});

test('an Ashby confirmation is a confirmation, and names its company', () => {
	// LIVE, 2026-08-21 — the message that proved the queue was incomplete.
	const parsed = parseMail(
		'Thank You for Applying! Pinecone Has Received Your Application',
		'ashbyhq.com'
	);
	assert.equal(parsed.kind, 'confirmation');
	assert.equal(parsed.company, 'pinecone');
});

test('ATS account mail is ignored and names no company', () => {
	// LIVE, 2026-09-08. Greenhouse talking about its own job-seeker product.
	// Treating this as an application event would invent one against whichever
	// employer happened to be nearby in time.
	const parsed = parseMail('Welcome to MyGreenhouse. Start your search.', 'us.greenhouse-jobs.com');
	assert.equal(parsed.kind, 'other');
	assert.equal(parsed.company, null);
});

test('a MyGreenhouse login code is a verification, not an application event', () => {
	// LIVE, 2026-09-08.
	const parsed = parseMail("Here's your MyGreenhouse security code", 'us.greenhouse-jobs.com');
	assert.equal(parsed.kind, 'verification');
});

test('"Start your search" does not yield a company called Start', () => {
	// Why COMPANY_PATTERNS is a short list of measured shapes rather than
	// "the capitalised word".
	assert.equal(companyFromSubject('Welcome to MyGreenhouse. Start your search.'), null);
});

test('company extraction handles the measured subject shapes', () => {
	assert.equal(companyFromSubject('Security code for your application to Coinbase'), 'coinbase');
	assert.equal(
		companyFromSubject('Thank You for Applying! Pinecone Has Received Your Application'),
		'pinecone'
	);
	assert.equal(companyFromSubject('Thank you for applying to Datadog'), 'datadog');
	assert.equal(companyFromSubject('Your application to Acme Corp was received'), 'acme corp');
});

test('a subject naming no company yields null rather than a guess', () => {
	assert.equal(companyFromSubject('Thanks for applying!'), null);
	assert.equal(companyFromSubject(''), null);
});

test('a sentence that happens to match is not accepted as a company', () => {
	const long = 'Security code for your application to ' + 'x'.repeat(80);
	assert.equal(companyFromSubject(long), null);
});

test('company matching tolerates case, suffixes and punctuation', () => {
	assert.ok(companiesMatch('Coinbase', 'coinbase'));
	assert.ok(companiesMatch('Datadog, Inc.', 'datadog'));
	assert.ok(companiesMatch('pinecone', 'Pinecone Systems'));
	assert.ok(companiesMatch('Toast Inc', 'toast'));
});

test('company matching rejects different employers', () => {
	assert.equal(companiesMatch('Coinbase', 'datadog'), false);
	assert.equal(companiesMatch('Pinterest', 'pinecone'), false);
	assert.equal(companiesMatch('', 'datadog'), false);
	assert.equal(companiesMatch('datadog', ''), false);
});

test('unrecognised wording from a granted domain is other, not a guessed kind', () => {
	// A shape we have not seen. Recording it as 'other' puts it in
	// mail_unmatched where a human can look; inventing a kind for it would be
	// the greenhouse.io mistake in another costume.
	const parsed = parseMail('An update on your candidacy', 'lever.co');
	assert.equal(parsed.kind, 'other');
});
