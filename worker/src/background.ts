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
import { canPostTelemetry, postServiceEvent } from './clients/telemetry.js';
import type { AppEnv } from './types.js';

export interface HasExecutionCtx {
	executionCtx?: { waitUntil(p: Promise<unknown>): void };
	/** The bindings, when the caller is a Hono context: lets a failure reach service_events. */
	env?: unknown;
}

/** Work whose own failure must not be reported through itself. */
const TELEMETRY_LABEL = 'telemetry:';

/**
 * Background work fails after its response has gone, so no request row shows
 * it. Post it to service_events (`event=background_failed`) as well as the
 * logger, which only Workers Logs can read.
 */
function reportFailure(env: unknown, label: string, message: string): Promise<void> {
	const bindings = env as AppEnv | undefined;
	if (label.startsWith(TELEMETRY_LABEL) || !canPostTelemetry(bindings)) return Promise.resolve();
	return postServiceEvent(bindings, {
		level: 'error',
		event: 'background_failed',
		message: `${label}: ${message}`,
		context: { task: label, error: message },
	}).catch((err: unknown) => {
		logger.error('telemetry: background failure not recorded', {
			task: label,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

/**
 * Run `work` after the response.
 *
 * `label` names the work in logs — it is what tells you WHICH background task
 * was dropped when a host stops forwarding its ExecutionContext.
 */
export function runAfterResponse(c: HasExecutionCtx, label: string, work: Promise<unknown>): void {
	const guarded = work.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		logger.error('background work failed', { task: label, error: message });
		return reportFailure(c.env, label, message);
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
		// Best effort, like the work itself: without a context this post may not survive either.
		void reportFailure(c.env, label, 'no ExecutionContext: background work dropped');
		return;
	}
	ctx.waitUntil(guarded);
}
