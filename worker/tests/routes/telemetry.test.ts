/**
 * POST /telemetry: the browser's events reach service_events, one row each,
 * with the identity the edge verified, never the one the body claims.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, BASE, type Harness } from '../helpers/harness.ts';
import { runAfterResponse } from '../../src/background.ts';

interface Posted {
	source: string;
	level: string;
	message: string;
	context: Record<string, unknown>;
}

const click = (label: string) => ({
	event: 'ui.click',
	at: Date.parse('2026-11-11T12:00:00Z'),
	props: { label, tag: 'button', route: '#/feed' },
});

describe('POST /telemetry', () => {
	let h: Harness;
	before(async () => {
		h = await createHarness();
	});
	after(async () => {
		await h.dispose();
	});

	it('forwards each event as its own browser row, in the background', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/telemetry`, {
			method: 'POST',
			tier: 'friend',
			userId: 'user-ada',
			body: JSON.stringify({
				app: 'jobpulse',
				session: 'sess_abc12345',
				events: [
					click('Save'),
					{ ...click('Dismiss'), props: { label: 'Dismiss', user_id: 'forged' } },
				],
			}),
		});
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { success: true, data: { accepted: 2 } });
		assert.equal(await h.settle(), 1, 'the forwarding is handed to waitUntil, not awaited');

		const rows = h.telemetry as Posted[];
		assert.equal(rows.length, 2);
		assert.equal(rows[0].source, 'browser');
		assert.equal(rows[0].message, 'event=ui.click jobpulse Save');
		assert.equal(rows[0].context.service, 'jobplatform');
		assert.equal(rows[0].context.app, 'jobpulse');
		assert.equal(rows[0].context.session, 'sess_abc12345');
		assert.equal(rows[0].context.user_id, 'user-ada');
		assert.equal(rows[0].context.tier, 'friend');
		assert.equal(rows[0].context.client_at, '2026-11-11T12:00:00.000Z');
		assert.equal(rows[1].context.user_id, 'user-ada', 'a user_id in the body never wins');
	});

	it('takes a signed-out visitor too, with no identity', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/telemetry`, {
			method: 'POST',
			body: JSON.stringify({
				app: 'jobplatform',
				session: 'sess_anon0001',
				events: [click('Feed')],
			}),
		});
		assert.equal(res.status, 202);
		await h.settle();
		const [row] = h.telemetry as Posted[];
		assert.equal(row.context.user_id, null);
		assert.equal(row.context.tier, 'public');
	});

	it('refuses an oversized or malformed batch before forwarding anything', async () => {
		h.telemetry.length = 0;
		const bad = [
			{
				app: 'jobplatform',
				session: 'sess_abc12345',
				events: Array.from({ length: 26 }, () => click('x')),
			},
			{ app: 'jobplatform', session: 'sess_abc12345', events: [] },
			{ app: 'other', session: 'sess_abc12345', events: [click('x')] },
			{ app: 'jobplatform', session: 'no spaces allowed', events: [click('x')] },
			{
				app: 'jobplatform',
				session: 'sess_abc12345',
				events: [{ ...click('x'), event: 'Bad Name' }],
			},
			{
				app: 'jobplatform',
				session: 'sess_abc12345',
				events: [{ ...click('x'), props: { label: 'y'.repeat(201) } }],
			},
		];
		for (const body of bad) {
			const res = await h.fetch(`${BASE}/telemetry`, {
				method: 'POST',
				body: JSON.stringify(body),
			});
			assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
		}
		await h.settle();
		assert.equal(h.telemetry.length, 0);
	});
});

describe('background work that fails', () => {
	it('is reported to service_events as background_failed', async () => {
		const posted: Posted[] = [];
		const pending: Promise<unknown>[] = [];
		const env = {
			HADOKU_SERVICE_KEY: 'k',
			EDGE: {
				fetch: (_url: string, init: RequestInit) => {
					posted.push(JSON.parse(String(init.body)) as Posted);
					return Promise.resolve(Response.json({ success: true }));
				},
			},
		};
		runAfterResponse(
			{ executionCtx: { waitUntil: (p) => void pending.push(p) }, env },
			'rank build p1',
			Promise.reject(new Error('no such table: job_profile_rank'))
		);
		await Promise.all(pending);
		assert.equal(posted.length, 1);
		assert.equal(posted[0].level, 'error');
		assert.equal(
			posted[0].message,
			'event=background_failed rank build p1: no such table: job_profile_rank'
		);
		assert.equal(posted[0].context.task, 'rank build p1');
	});

	it("never reports the telemetry relay's own failure through itself", async () => {
		const posted: unknown[] = [];
		const pending: Promise<unknown>[] = [];
		const env = {
			HADOKU_SERVICE_KEY: 'k',
			EDGE: {
				fetch: (_u: string, init: RequestInit) => (
					posted.push(init.body),
					Promise.resolve(Response.json({}))
				),
			},
		};
		runAfterResponse(
			{ executionCtx: { waitUntil: (p) => void pending.push(p) }, env },
			'telemetry: browser relay',
			Promise.reject(new Error('monitoring-api answered 500'))
		);
		await Promise.all(pending);
		assert.equal(posted.length, 0);
	});
});

describe('operation events', () => {
	let h: Harness;
	before(async () => {
		h = await createHarness();
	});
	after(async () => {
		await h.dispose();
	});

	const rows = () => h.telemetry as Posted[];
	const named = (event: string) => rows().filter((r) => r.message.startsWith(`event=${event} `));

	it('ingest posts one ingest.batch row with what the batch did', async () => {
		h.telemetry.length = 0;
		const job = (n: number) => ({
			id: `op-${n}`,
			url: `https://jobs.ashbyhq.com/acme/op-${n}`,
			source_site: 'ashby',
			title: 'Software Engineer',
			company: 'Acme',
			location: 'Remote',
			job_type: 'fulltime',
			workplace_type: 'remote',
			description: 'Build things.',
			raw: {},
		});
		const send = (jobs: unknown[]) =>
			h.fetch(`${BASE}/ingest`, {
				method: 'POST',
				tier: 'service',
				body: JSON.stringify({
					jobs,
					source: 'ashby',
					board_slug: 'acme',
					batch_number: 1,
					is_final: true,
				}),
			});
		assert.equal((await send([job(1), job(2)])).status, 200);
		assert.equal((await send([job(2), job(3)])).status, 200);
		await h.settle();
		const batches = named('ingest.batch');
		assert.equal(batches.length, 2);
		assert.equal(batches[1].context.received, 2);
		assert.equal(batches[1].context.accepted, 1);
		assert.equal(batches[1].context.already_known, 1);
		assert.equal(batches[1].context.board_slug, 'acme');
		assert.equal(named('api.change').length, 0, 'ingest is not double-reported');
	});

	it('a state change posts job.state, and only that', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/jobs/op-1/state`, {
			method: 'PUT',
			tier: 'friend',
			userId: 'user-op',
			body: JSON.stringify({ state: 'saved' }),
		});
		assert.equal(res.status, 200);
		await h.settle();
		assert.equal(rows().length, 1, JSON.stringify(rows()));
		assert.equal(named('job.state')[0].context.to, 'saved');
		assert.equal(named('job.state')[0].context.from, null);
	});

	it('any other change posts api.change with structural values and field names only', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/application-answers`, {
			method: 'PUT',
			tier: 'friend',
			userId: 'user-op',
			body: JSON.stringify({ question: 'Expected salary?', answer: '250000 secret' }),
		});
		assert.ok(res.status < 500, String(res.status));
		await h.settle();
		const [row] = named('api.change');
		assert.ok(row, JSON.stringify(rows()));
		assert.equal(row.context.method, 'PUT');
		assert.equal(row.context.path, '/application-answers');
		assert.equal(row.context.user_id, 'user-op');
		assert.deepEqual(row.context.fields, ['question', 'answer']);
		assert.ok(!JSON.stringify(row).includes('250000'), 'free text never reaches the log');
	});

	it('a DELETE names its target from the query string', async () => {
		h.telemetry.length = 0;
		await h.fetch(`${BASE}/blocked-companies?company=Acme`, {
			method: 'DELETE',
			tier: 'friend',
			userId: 'user-op',
		});
		await h.settle();
		const [row] = named('api.change');
		assert.equal(row.context.company, 'Acme');
		assert.deepEqual(row.context.fields, ['company']);
	});

	it('a refused import says why', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/jobs/import`, {
			method: 'POST',
			tier: 'friend',
			userId: 'user-op',
			body: JSON.stringify({ url: 'https://jobs.lever.co/linkedin/abc' }),
		});
		assert.equal(res.status, 422);
		await h.settle();
		const [row] = named('job.import');
		assert.equal(row.level, 'warn');
		assert.equal(row.context.outcome, 'refused: test board');
	});

	it('reads post nothing', async () => {
		h.telemetry.length = 0;
		await h.fetch(`${BASE}/jobs`, { tier: 'friend', userId: 'user-op' });
		await h.fetch(`${BASE}/pipeline`, { tier: 'friend', userId: 'user-op' });
		await h.settle();
		assert.equal(rows().length, 0, JSON.stringify(rows()));
	});
});

describe('company lookups', () => {
	let h: Harness;
	let server: import('node:http').Server;
	before(async () => {
		const { createServer } = await import('node:http');
		server = createServer((req, res) => {
			let raw = '';
			req.on('data', (c: Buffer) => (raw += c.toString()));
			req.on('end', () => {
				res.writeHead(req.url?.endsWith('/match') ? 500 : 200, {
					'Content-Type': 'application/json',
				});
				if (req.url?.endsWith('/match')) return res.end(JSON.stringify({ detail: 'boom' }));
				const { slugs } = JSON.parse(raw) as { slugs: string[] };
				res.end(
					JSON.stringify({
						success: true,
						data: { results: slugs.map((slug) => ({ slug, hits: [], unreachable: ['lever'] })) },
					})
				);
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as import('node:net').AddressInfo;
		h = await createHarness({ scraperUrl: `http://127.0.0.1:${port}` });
	});
	after(async () => {
		await h.dispose();
		await new Promise<void>((r) => server.close(() => r()));
	});

	const named = (event: string) =>
		(h.telemetry as Posted[]).filter((r) => r.message.startsWith(`event=${event} `));

	it('a probe that could not ask a provider says so, and passes it on', async () => {
		h.telemetry.length = 0;
		const res = await h.json<{ data: { results: { unreachable?: string[] }[] } }>(
			`${BASE}/companies/probe`,
			{
				method: 'POST',
				tier: 'friend',
				userId: 'user-op',
				body: JSON.stringify({ slugs: ['scale'] }),
			}
		);
		assert.equal(res.status, 200);
		assert.deepEqual(res.body.data.results[0].unreachable, ['lever']);
		await h.settle();
		const [row] = named('companies.probe');
		assert.equal(row.level, 'warn');
		assert.deepEqual(row.context.unreachable, ['lever']);
		assert.equal(named('api.change').length, 0);
	});

	it('a scraper failure is an error row, not just our 502', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/companies/match`, {
			method: 'POST',
			tier: 'friend',
			userId: 'user-op',
			body: JSON.stringify({ names: ['Scale AI'] }),
		});
		assert.equal(res.status, 502);
		await h.settle();
		const [row] = named('companies.match_failed');
		assert.equal(row.level, 'error');
		assert.equal(row.context.scraper_status, 500);
	});
});
