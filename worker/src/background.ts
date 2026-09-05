/**
 * Running work after the response, and noticing when we cannot.
 *
 * On Workers, a promise that is not handed to `ctx.waitUntil()` is killed the
 * moment the response returns. Hono's `c.executionCtx` getter THROWS when the
 * runtime gave it no context — which happens whenever a host worker forwards
 * `(request, env)` and drops the third argument. The obvious way to write that
 * guard is also the trap:
 *
 *     try { c.executionCtx?.waitUntil(work); } catch { void work; }
 *
 * The catch turns a broken deployment into a silent one. The request still
 * succeeds; the work simply never happens; nothing is logged. Two features sat
 * dead behind exactly this — the feed's rank build and the scrape kicked when a
 * directive is added — and the tests agreed with them, because node runs an
 * unattached promise to completion where Workers does not.
 *
 * So the swallow is gone. Losing the context is reported as an error naming the
 * work that was dropped, and the promise is still started, because best-effort
 * beats nothing when the runtime happens to allow it.
 */
import { logger } from './logger.js';

export interface HasExecutionCtx {
	executionCtx?: { waitUntil(p: Promise<unknown>): void };
}

/**
 * Run `work` after the response.
 *
 * `label` names the work in logs — it is what tells you WHICH background task
 * was dropped when a host stops forwarding its ExecutionContext.
 */
export function runAfterResponse(c: HasExecutionCtx, label: string, work: Promise<unknown>): void {
	const guarded = work.catch((error: unknown) => {
		logger.error('background work failed', {
			task: label,
			error: error instanceof Error ? error.message : String(error),
		});
	});

	let ctx: HasExecutionCtx['executionCtx'];
	try {
		ctx = c.executionCtx;
	} catch {
		ctx = undefined;
	}

	if (!ctx) {
		logger.error('no ExecutionContext — background work will not survive the response', {
			task: label,
			hint: 'the host worker must forward ctx: fetch(request, env, ctx) -> createFetchHandler(env)(request, ctx)',
		});
		void guarded;
		return;
	}
	ctx.waitUntil(guarded);
}
