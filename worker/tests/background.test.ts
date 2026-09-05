/**
 * runAfterResponse — and the failure it exists to stop being silent.
 *
 * Work that is not handed to ctx.waitUntil() is killed with the response on
 * Workers. Hono's executionCtx getter throws when the runtime supplied none,
 * which is what happens the moment a host worker forwards (request, env) and
 * drops the third argument. The previous shape of this code caught that and
 * carried on, so two features ran nowhere for weeks while every request
 * returned 200 and nothing was logged.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runAfterResponse } from '../src/background.ts';

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

describe('runAfterResponse', () => {
	it('hands the work to waitUntil when there is a context', async () => {
		const kept: Promise<unknown>[] = [];
		let ran = false;
		const work = Promise.resolve().then(() => {
			ran = true;
		});

		runAfterResponse({ executionCtx: { waitUntil: (p) => kept.push(p) } }, 'demo', work);

		assert.equal(kept.length, 1, 'the promise was handed to waitUntil, not merely started');
		await Promise.allSettled(kept);
		assert.equal(ran, true);
	});

	// The regression. A host that forwards (request, env) leaves Hono with no
	// context; this must be loud, because everything else about the request
	// still looks fine.
	it('reports it loudly when the ExecutionContext is missing', async () => {
		let ran = false;
		const work = Promise.resolve().then(() => {
			ran = true;
		});

		// Hono THROWS from the getter rather than returning undefined.
		const noCtx = {
			get executionCtx(): never {
				throw new Error('This context has no ExecutionContext');
			},
		};
		runAfterResponse(noCtx, 'orphaned-task', work);

		const logged = cap.seen.join('\n');
		assert.match(logged, /no ExecutionContext/i, `expected a loud complaint, got:\n${logged}`);
		assert.match(logged, /orphaned-task/, 'names the work that was dropped');

		// Still started, best effort — it just cannot be relied on to finish.
		await work;
		assert.equal(ran, true);
	});

	it('reports a failure in the work itself, naming the task', async () => {
		const kept: Promise<unknown>[] = [];
		runAfterResponse(
			{ executionCtx: { waitUntil: (p) => kept.push(p) } },
			'exploding-task',
			Promise.reject(new Error('kaboom'))
		);
		await Promise.allSettled(kept);

		const logged = cap.seen.join('\n');
		assert.match(logged, /exploding-task/);
		assert.match(logged, /kaboom/);
	});

	it('does not let a rejection escape as an unhandled rejection', async () => {
		const kept: Promise<unknown>[] = [];
		runAfterResponse(
			{ executionCtx: { waitUntil: (p) => kept.push(p) } },
			'rejects',
			Promise.reject(new Error('nope'))
		);
		// waitUntil receives the GUARDED promise, so awaiting it must not throw —
		// an unhandled rejection inside waitUntil can fail the whole invocation.
		await assert.doesNotReject(() => Promise.all(kept));
	});
});
