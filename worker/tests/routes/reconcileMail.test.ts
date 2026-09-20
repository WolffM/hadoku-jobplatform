import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHarness, BASE } from '../helpers/harness.ts';
import { seedJob } from '../helpers/seed.ts';

/**
 * Reconciling the mailbox against the queue, through the real worker.
 *
 * The messages below are the real 2026-09-19 feed. They are the whole reason
 * this feature exists: the queue reported zero applications sent while a
 * Pinecone confirmation sat unread for an application it had no row for.
 */

interface FeedMessage {
	id: string;
	receivedAt: number;
	from: string;
	fromDomain: string;
	subject: string;
	body: string;
	source: 'live' | 'archive';
}

/** A loopback contact-api. Records the key it was presented. */
async function startFeed(opts: {
	messages: FeedMessage[];
	domains?: string[];
	scopeStatus?: number;
}): Promise<{ url: string; keys: string[]; stop(): Promise<void> }> {
	const keys: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		keys.push(String(req.headers['x-user-key'] ?? ''));
		const url = new URL(req.url ?? '/', 'http://localhost');
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (url.pathname.endsWith('/scope')) {
			if (opts.scopeStatus && opts.scopeStatus !== 200) return send(opts.scopeStatus, {});
			return send(200, {
				success: true,
				data: {
					label: 'jobplatform',
					senderDomains: opts.domains ?? ['greenhouse-mail.io', 'ashbyhq.com'],
				},
			});
		}
		if (url.pathname.endsWith('/messages')) {
			// One page; the cursor loop is exercised by nextCursor being null.
			return send(200, {
				success: true,
				data: { messages: opts.messages, nextCursor: null },
			});
		}
		return send(404, { success: false, error: 'Not found' });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		keys,
		stop: () => new Promise<void>((r) => server.close(() => r())),
	};
}

const AUG21 = Date.UTC(2026, 7, 21, 17, 32, 45, 635);
const SEP16 = Date.UTC(2026, 8, 16, 17, 33, 44, 0);

function mail(over: Partial<FeedMessage> & { subject: string; id: string }): FeedMessage {
	return {
		receivedAt: SEP16,
		from: 'no-reply@us.greenhouse-mail.io',
		fromDomain: 'us.greenhouse-mail.io',
		body: 'irrelevant — bodies are never persisted',
		source: 'live',
		...over,
	};
}

async function seedApplication(
	h: Awaited<ReturnType<typeof createHarness>>,
	opts: { id: string; jobId: string; company: string; createdAt: string }
): Promise<void> {
	await seedJob(h.db, {
		id: opts.jobId,
		title: 'Staff Software Engineer',
		company: opts.company,
	});
	await h.db
		.prepare(
			`INSERT INTO applications
			   (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
			 VALUES (?, 'user-hadoku', ?, 'v1', 'review', 'filled', ?, ?)`
		)
		.bind(opts.id, opts.jobId, opts.createdAt, opts.createdAt)
		.run();
}

test('a Greenhouse security code marks the application awaiting verification, not confirmed', async () => {
	// THE case. Two Coinbase applications sat in `failed` under "MAY OR MAY NOT
	// have been sent"; the inbox says plainly they are blocked on a human.
	const feed = await startFeed({
		messages: [mail({ id: 'm1', subject: 'Security code for your application to Coinbase' })],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await seedApplication(h, {
			id: 'app-cb',
			jobId: 'greenhouse_8051871',
			company: 'coinbase',
			createdAt: '2026-09-16T17:00:00.000Z',
		});

		const { status, body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(status, 200);
		assert.equal(body.data.verification_flagged, 1);
		assert.equal(body.data.confirmed, 0);

		const row = await h.db
			.prepare('SELECT confirmed_at, verification_requested_at FROM applications WHERE id = ?')
			.bind('app-cb')
			.first<{ confirmed_at: string | null; verification_requested_at: string | null }>();
		assert.equal(row?.confirmed_at, null, 'a code is not a confirmation');
		assert.ok(row?.verification_requested_at, 'the code mail must set the waiting-on-human state');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('reconciliation never overwrites the runner status — the disagreement is the product', async () => {
	const feed = await startFeed({
		messages: [mail({ id: 'm1', subject: 'Security code for your application to Coinbase' })],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await seedApplication(h, {
			id: 'app-cb',
			jobId: 'greenhouse_8051871',
			company: 'coinbase',
			createdAt: '2026-09-16T17:00:00.000Z',
		});
		await h.db
			.prepare("UPDATE applications SET status = 'failed' WHERE id = ?")
			.bind('app-cb')
			.run();

		await h.json(`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`, {
			method: 'POST',
			tier: 'service',
		});

		const row = await h.db
			.prepare('SELECT status FROM applications WHERE id = ?')
			.bind('app-cb')
			.first<{ status: string }>();
		assert.equal(row?.status, 'failed', 'status is the runner’s account and must survive intact');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('a confirmation for an application we have no row for is recorded, not dropped', async () => {
	// The Pinecone case, and the reason the whole feature exists.
	const feed = await startFeed({
		messages: [
			mail({
				id: 'pine-1',
				receivedAt: AUG21,
				from: 'no-reply@ashbyhq.com',
				fromDomain: 'ashbyhq.com',
				subject: 'Thank You for Applying! Pinecone Has Received Your Application',
			}),
		],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const { body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.unmatched, 1);

		const row = await h.db
			.prepare('SELECT company, kind, subject FROM mail_unmatched WHERE message_id = ?')
			.bind('pine-1')
			.first<{ company: string; kind: string; subject: string }>();
		assert.equal(row?.company, 'pinecone');
		assert.equal(row?.kind, 'confirmation');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('two confirmations for one company minutes apart are flagged, never counted as two', async () => {
	// The real Pinecone pair: 20.2s apart, identical subjects, no role named.
	// Inventing a second application the owner never made would be the same
	// phantom row this feature exists to eliminate.
	const feed = await startFeed({
		messages: [
			mail({
				id: 'pine-1',
				receivedAt: AUG21,
				fromDomain: 'ashbyhq.com',
				subject: 'Thank You for Applying! Pinecone Has Received Your Application',
			}),
			mail({
				id: 'pine-2',
				receivedAt: AUG21 + 20_198,
				fromDomain: 'ashbyhq.com',
				subject: 'Thank You for Applying! Pinecone Has Received Your Application',
			}),
		],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const { body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.duplicates_flagged, 1, 'the second must be flagged against the first');

		const second = await h.db
			.prepare('SELECT possible_duplicate_of FROM mail_unmatched WHERE message_id = ?')
			.bind('pine-2')
			.first<{ possible_duplicate_of: string | null }>();
		assert.equal(second?.possible_duplicate_of, 'pine-1');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('ATS account mail marks nothing', async () => {
	// "Welcome to MyGreenhouse" alongside a real application to another company.
	// Attaching it to that application would invent an event.
	const feed = await startFeed({
		messages: [
			mail({
				id: 'acct',
				fromDomain: 'us.greenhouse-jobs.com',
				subject: 'Welcome to MyGreenhouse. Start your search.',
			}),
		],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await seedApplication(h, {
			id: 'app-dd',
			jobId: 'greenhouse_3851927',
			company: 'datadog',
			createdAt: '2026-09-16T17:00:00.000Z',
		});

		const { body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.ignored, 1);
		assert.equal(body.data.unmatched, 0);

		const row = await h.db
			.prepare('SELECT confirmed_at, verification_requested_at FROM applications WHERE id = ?')
			.bind('app-dd')
			.first<{ confirmed_at: string | null; verification_requested_at: string | null }>();
		assert.equal(row?.confirmed_at, null);
		assert.equal(row?.verification_requested_at, null);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('an unreachable feed is a 502, never an empty mailbox', async () => {
	// "No mail" and "no access" look identical downstream, and telling them
	// apart is the entire point of the feature.
	const h = await createHarness(); // default: a closed port
	try {
		const { status, body } = await h.json<{ success: boolean; message: string }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(status, 502);
		assert.equal(body.success, false);
	} finally {
		await h.dispose();
	}
});

test('a 403 from the feed is reported rather than read as silence', async () => {
	const feed = await startFeed({ messages: [], scopeStatus: 403 });
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const { status, body } = await h.json<{ message: string }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{
				method: 'POST',
				tier: 'service',
			}
		);
		assert.equal(status, 502);
		assert.match(body.message, /403/);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('an empty grant is warned about, because it makes every poll look quiet', async () => {
	const feed = await startFeed({ messages: [], domains: [] });
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const { body } = await h.json<{ data: { warnings: string[]; scope_domains: number } }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.scope_domains, 0);
		assert.equal(body.data.warnings.length, 1);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('the feed is called with the service key, and no mail credential exists', async () => {
	const feed = await startFeed({ messages: [] });
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await h.json(`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`, {
			method: 'POST',
			tier: 'service',
		});
		assert.ok(feed.keys.length > 0);
		assert.ok(
			feed.keys.every((k) => k === 'test-service-key'),
			'auth is the service identity we already hold — there is no mailbox password'
		);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('the reconciler is gated — public callers cannot read the mailbox', async () => {
	const feed = await startFeed({ messages: [] });
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const res = await h.fetch(`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`, { method: 'POST' });
		// 403, not 401: the gate is about tier, and an unauthed caller is `public`
		// rather than unknown. Matches every other gated route in this suite.
		assert.equal(res.status, 403);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('message bodies are never written to the database', async () => {
	// docs/DECISION-mail-reconciler.md: a code mail sets state, its contents are
	// never parsed, stored, logged or displayed. This is that promise, enforced.
	const secret = 'CODE-85luhtcH-SECRET';
	const feed = await startFeed({
		messages: [
			mail({
				id: 'm1',
				subject: 'Security code for your application to Coinbase',
				body: `Your security code is ${secret}`,
			}),
		],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await h.json(`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`, {
			method: 'POST',
			tier: 'service',
		});

		// Sweep every text column of every table this feature writes.
		for (const table of ['mail_unmatched', 'applications', 'mail_reconcile_state']) {
			const rows = await h.db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
			for (const row of rows.results) {
				for (const value of Object.values(row)) {
					if (typeof value !== 'string') continue;
					assert.ok(!value.includes(secret), `${table} must not contain a verification code`);
				}
			}
		}
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

/**
 * The two defects the first production backfill exposed.
 *
 * It reported `confirmed: 2, verification_flagged: 0, duplicates_flagged: 3`
 * for a mailbox with no Pinecone application, two genuine Coinbase codes and
 * exactly one genuine duplicate pair. Every one of those three numbers was
 * wrong, and each is pinned below.
 */

test('mail never matches another identity’s applications', async () => {
	// `confirmed: 2` for Pinecone against an owner who has never applied there.
	// The query had no user filter, so it reached whatever rows existed —
	// writing a confirmation onto an application the mail says nothing about.
	const feed = await startFeed({
		messages: [
			mail({
				id: 'pine-1',
				receivedAt: AUG21,
				fromDomain: 'ashbyhq.com',
				subject: 'Thank You for Applying! Pinecone Has Received Your Application',
			}),
		],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		// Somebody ELSE applied to Pinecone. The mailbox owner did not.
		await seedJob(h.db, { id: 'ashby_pine_1', title: 'Engineer', company: 'pinecone' });
		await h.db
			.prepare(
				`INSERT INTO applications
				   (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
				 VALUES ('other-app', 'user-someone-else', 'ashby_pine_1', 'v1', 'review',
				         'filled', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`
			)
			.run();

		const { body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.confirmed, 0, 'must not confirm against another user’s row');
		assert.equal(body.data.unmatched, 1, 'it is unmatched FOR THIS OWNER, and recorded as such');

		const theirs = await h.db
			.prepare('SELECT confirmed_at FROM applications WHERE id = ?')
			.bind('other-app')
			.first<{ confirmed_at: string | null }>();
		assert.equal(theirs?.confirmed_at, null, 'the other identity’s row must be untouched');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('a re-run does not make every mail a duplicate of its own earlier record', async () => {
	// `duplicates_flagged: 3` on a mailbox with one genuine pair. The second
	// pass found each message's own row from the first pass sitting inside the
	// ten-minute window and flagged it against itself.
	const feed = await startFeed({
		messages: [mail({ id: 'air-1', subject: 'Security code for your application to Airtable' })],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		const first = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(first.body.data.duplicates_flagged, 0);

		const second = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku&reset=true`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(second.body.data.duplicates_flagged, 0, 'a replay must not invent a duplicate');

		const row = await h.db
			.prepare('SELECT possible_duplicate_of FROM mail_unmatched WHERE message_id = ?')
			.bind('air-1')
			.first<{ possible_duplicate_of: string | null }>();
		assert.equal(row?.possible_duplicate_of, null);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('an application queued weeks before its code mail still matches', async () => {
	// `verification_flagged: 0` for two real Coinbase codes. The window was
	// anchored ±14 days on `created_at`, which is when the row was QUEUED —
	// routinely long before anything is submitted.
	const feed = await startFeed({
		messages: [mail({ id: 'cb-1', subject: 'Security code for your application to Coinbase' })],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await seedApplication(h, {
			id: 'app-cb',
			jobId: 'greenhouse_8051871',
			company: 'coinbase',
			// Queued ten weeks before the code arrived.
			createdAt: '2026-07-08T00:00:00.000Z',
		});

		const { body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.verification_flagged, 1);
		assert.equal(body.data.unmatched, 0);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('an application queued AFTER the mail is not matched to it', async () => {
	// The bound that still does real work: an employer cannot acknowledge an
	// application that does not exist yet.
	const feed = await startFeed({
		messages: [mail({ id: 'cb-1', subject: 'Security code for your application to Coinbase' })],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await seedApplication(h, {
			id: 'app-later',
			jobId: 'greenhouse_8051871',
			company: 'coinbase',
			createdAt: '2026-10-20T00:00:00.000Z',
		});

		const { body } = await h.json<{ data: Record<string, number> }>(
			`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`,
			{ method: 'POST', tier: 'service' }
		);
		assert.equal(body.data.verification_flagged, 0);
		assert.equal(body.data.unmatched, 1);
	} finally {
		await h.dispose();
		await feed.stop();
	}
});

test('the results can actually be read back', async () => {
	// The first version shipped a writer with no reader, so a feature whose
	// whole purpose is making a disagreement visible delivered nothing to look
	// at. This is that reader.
	const feed = await startFeed({
		messages: [
			mail({ id: 'cb-1', subject: 'Security code for your application to Coinbase' }),
			mail({
				id: 'pine-1',
				receivedAt: AUG21,
				fromDomain: 'ashbyhq.com',
				subject: 'Thank You for Applying! Pinecone Has Received Your Application',
			}),
		],
	});
	const h = await createHarness({ mailFeedUrl: feed.url });
	try {
		await seedApplication(h, {
			id: 'app-cb',
			jobId: 'greenhouse_8051871',
			company: 'coinbase',
			createdAt: '2026-09-09T00:00:00.000Z',
		});
		await h.json(`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`, {
			method: 'POST',
			tier: 'service',
		});

		const { status, body } = await h.json<{
			data: {
				lastRunAt: string | null;
				unmatched: { company: string; kind: string }[];
				applications: { company: string; verification_requested_at: string | null }[];
			};
		}>(`${BASE}/ingest/reconcile-mail?ownerName=Hadoku`, { tier: 'service' });

		assert.equal(status, 200);
		assert.ok(body.data.lastRunAt, 'the run must be visible');
		assert.equal(body.data.applications.length, 1);
		assert.equal(body.data.applications[0].company, 'coinbase');
		assert.ok(body.data.applications[0].verification_requested_at);
		// Pinecone has no application for this owner, so it shows as unmatched —
		// which is the Pinecone finding, surfaced rather than buried.
		assert.equal(body.data.unmatched.length, 1);
		assert.equal(body.data.unmatched[0].company, 'pinecone');
	} finally {
		await h.dispose();
		await feed.stop();
	}
});
