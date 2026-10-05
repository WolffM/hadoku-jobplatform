import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, BASE } from '../helpers/harness.ts';
import { startFeed, type FeedMessage } from '../helpers/mailFeed.ts';

/**
 * GET /verification-codes: the owner reads Greenhouse's codes on the dashboard
 * (asked for 2026-10-04), and NOBODY else can — not a friend-tier person, and
 * above all not the runner's service key.
 */

const minutesAgo = (n: number) => Date.now() - n * 60_000;

function mail(over: Partial<FeedMessage> & { id: string; subject: string }): FeedMessage {
	return {
		receivedAt: minutesAgo(2),
		from: 'no-reply@us.greenhouse-mail.io',
		fromDomain: 'us.greenhouse-mail.io',
		body: '',
		source: 'live',
		...over,
	};
}

const FEED: FeedMessage[] = [
	mail({
		id: 'gh-1',
		subject: 'Security code for your application to Instacart',
		body: 'Copy and paste this code into the security code field on your application:\r\n\r\nAb3dE9xQ\r\n\r\nThanks,\r\nGreenhouse',
	}),
	mail({
		id: 'gh-2',
		subject: 'Security code for your application to Toast',
		receivedAt: minutesAgo(30),
		body: 'Something we have never seen before, with no code in it.',
	}),
	mail({
		id: 'ashby-1',
		from: 'no-reply@ashbyhq.com',
		fromDomain: 'ashbyhq.com',
		subject: 'Thank You for Applying! Pinecone Has Received Your Application',
		body: 'Thanks',
	}),
	mail({
		id: 'old',
		subject: 'Security code for your application to Coinbase',
		receivedAt: minutesAgo(60 * 24),
		body: 'Your code: ZZ99ZZ99',
	}),
];

interface Code {
	id: string;
	company: string | null;
	code: string | null;
	text: string | null;
}

test('the owner sees recent codes, newest first, and nothing that is not a code', async () => {
	const feed = await startFeed({ messages: FEED });
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const { status, body } = await h.json<{ data: { codes: Code[] } }>(
			`${BASE}/verification-codes`,
			{ tier: 'admin' }
		);
		assert.equal(status, 200);
		const codes = body.data.codes;
		assert.deepEqual(
			codes.map((c) => c.id),
			['gh-1', 'gh-2'],
			'no confirmation, nothing older than the window'
		);
		assert.equal(codes[0]?.code, 'Ab3dE9xQ');
		assert.equal(codes[0]?.company, 'instacart');
		assert.equal(codes[0]?.text, null);
		assert.equal(codes[1]?.code, null, 'never a guessed code');
		assert.match(codes[1]?.text ?? '', /never seen before/, 'the mail itself, to read by eye');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('no one but the mailbox owner, as themselves, can read a code', async () => {
	const feed = await startFeed({ messages: FEED });
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		for (const tier of ['friend', 'service']) {
			const { status } = await h.json(`${BASE}/verification-codes`, { tier });
			assert.equal(status, 403, `${tier} must not read the owner's codes`);
		}
		const { status } = await h.json(`${BASE}/verification-codes?ownerName=Hadoku`, {
			tier: 'admin',
		});
		assert.equal(status, 400, 'never on behalf of anyone');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});
