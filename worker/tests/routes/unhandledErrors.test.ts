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

/** A posting the database has not seen, so the batch reaches the rank step that fails. */
let seq = 0;
const freshJob = () => ({
	id: `err-${++seq}`,
	url: `https://jobs.ashbyhq.com/acme/err-${seq}`,
	source_site: 'ashby',
	title: 'Software Engineer',
	company: 'Acme',
	location: 'Remote',
	job_type: 'fulltime',
	workplace_type: 'remote',
	description: 'Build things.',
	raw: {},
});

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
				jobs: [freshJob()],
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

	it('reports the failure to service_events, in the background (issue #26)', async () => {
		h.telemetry.length = 0;
		const res = await h.fetch(`${BASE}/ingest`, {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({
				jobs: [freshJob()],
				source: 'ashby',
				batch_number: 1,
				is_final: true,
			}),
		});
		assert.equal(res.status, 500);
		assert.ok((await h.settle()) >= 1, 'the post was handed to waitUntil');
		assert.equal(h.telemetry.length, 1);
		const row = h.telemetry[0] as {
			source: string;
			level: string;
			message: string;
			context: Record<string, unknown>;
		};
		assert.equal(row.source, 'worker');
		assert.equal(row.level, 'error');
		assert.match(row.message, /^event=unhandled_error POST \/jobplatform\/api\/ingest /);
		assert.equal(row.context.service, 'jobplatform');
		assert.equal(row.context.status, 500);
		assert.equal(row.context.transient, false);
		assert.match(String(row.context.message), /no such table: job_profile_rank_state/);
	});

	it('still says which step it got to, in Server-Timing', async () => {
		const res = await h.fetch(`${BASE}/ingest`, {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({
				jobs: [freshJob()],
				source: 'ashby',
				batch_number: 1,
				is_final: true,
			}),
		});
		assert.equal(res.status, 500);
		const timing = res.headers.get('Server-Timing') ?? '';
		assert.match(timing, /\binsert;dur=/);
		assert.match(timing, /\btotal;dur=/);
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

	it("counts D1's bare internal error as transient: 39 batches lost to it on 2026-10-30", async () => {
		const internal = new Error(
			'D1_ERROR: internal error; reference = e_Gz3hrU_6ba99e4f976c4c8e904d7323e6c91166'
		);
		assert.ok(isTransientD1Error(internal));
		const res = await appThrowing(internal).request('/ingest', { method: 'POST' });
		assert.equal(res.status, 503);
		assert.equal(res.headers.get('Retry-After'), '5');
	});

	it('does not take any "internal error" for a D1 one', () => {
		assert.equal(isTransientD1Error(new Error('upstream internal error')), false);
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
