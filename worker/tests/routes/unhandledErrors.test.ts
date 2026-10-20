/**
 * What a caller and the logs see when a route throws (issue #24).
 *
 * The 2026-10-20 scrape lost 43 batches to a 500 whose log entry was a D1
 * stack with no message, and whose body was identical for a transient refusal
 * and a real bug. The scraper does not retry, so the batches were gone.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createHarness, BASE, EDGE_SECRET, type Harness } from '../helpers/harness.ts';
import { errorHandler, isTransientD1Error } from '../../src/errorHandler.ts';

const AUTH = {
	'X-Edge-Auth': EDGE_SECRET,
	'X-Hadoku-Tier': 'service',
	'X-User-Id': 'u-scraper',
	'Content-Type': 'application/json',
};

/** Capture what the worker logger writes, without touching its transport. */
function captureErrors() {
	const seen: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		seen.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	};
	return { seen, restore: () => (console.error = original) };
}

let cap: ReturnType<typeof captureErrors>;
beforeEach(() => {
	cap = captureErrors();
});
afterEach(() => cap.restore());

describe('a real D1 failure inside a route', () => {
	let h: Harness;
	before(async () => {
		h = await createHarness();
		await h.db.exec('DROP TABLE job_profile_rank_state');
	});
	after(async () => {
		await h.dispose();
	});

	it('answers 500 and logs the message, not just the stack', async () => {
		const res = await h.fetch(`${BASE}/ingest`, {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({
				jobs: [
					{
						id: 'err-1',
						url: 'https://jobs.ashbyhq.com/acme/err-1',
						source_site: 'ashby',
						title: 'Software Engineer',
						company: 'Acme',
						location: 'Remote',
						job_type: 'fulltime',
						workplace_type: 'remote',
						description: 'Build things.',
						raw: {},
					},
				],
				source: 'ashby',
				batch_number: 1,
				is_final: true,
			}),
		});
		assert.equal(res.status, 500);
		assert.equal(res.headers.get('Retry-After'), null, 'a missing table is not worth retrying');
		const logged = cap.seen.join('\n');
		assert.match(logged, /no such table: job_profile_rank_state/);
		assert.match(logged, /\/jobplatform\/api\/ingest/);
	});
});

describe('a transient D1 refusal', () => {
	const overloaded = new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');

	function appThrowing(err: Error) {
		const app = new Hono();
		app.post('/ingest', () => {
			throw err;
		});
		app.onError(errorHandler);
		return app;
	}

	it('answers 503 with Retry-After so the caller can tell it from a bug', async () => {
		const res = await appThrowing(overloaded).request('/ingest', { method: 'POST' });
		assert.equal(res.status, 503);
		assert.equal(res.headers.get('Retry-After'), '5');
		const body = (await res.json()) as { success: boolean; error: string };
		assert.equal(body.success, false);
		assert.equal(body.error, 'Service unavailable');
		assert.match(cap.seen.join('\n'), /D1 DB is overloaded/);
	});

	it('is recognised through a wrapping cause', () => {
		assert.ok(
			isTransientD1Error(new Error('D1_ERROR', { cause: new Error('Network connection lost.') }))
		);
	});

	it('is not every D1 error', () => {
		assert.equal(isTransientD1Error(new Error('D1_ERROR: no such table: jobs')), false);
		assert.equal(isTransientD1Error('D1 DB is overloaded'), false, 'only Errors are matched');
	});
});
