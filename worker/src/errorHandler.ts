/**
 * The last-resort handler for an exception no route caught.
 *
 * It replaces worker-utils' generic one for two reasons, both learned from
 * issue #24 (43 ingest batches refused in the opening seconds of the
 * 2026-10-20 scrape):
 *
 * 1. The generic handler logs `console.error('Unhandled error:', err)`, and
 *    Workers Logs records a D1 error as its stack with the first line gone, so
 *    every one of those 43 entries read `Unhandled error:  at
 *    D1DatabaseSessionAlwaysPrimary._sendOrThrow ...`. That is a stack with no
 *    message. The message and cause are logged here as their own fields.
 *
 * 2. Every failure answered 500 with the same body, so the scraper could not
 *    tell "D1 shed load for a few seconds" from "this batch is bad". The
 *    failures that day were D1 refusing within 10-70ms while four other
 *    batches held it for ~9s each. They were transient, and a transient D1
 *    failure now answers 503 with Retry-After.
 *
 * Issue #26 added two more. The 2026-10-30 scrape lost 39 batches in a
 * five-second window to `D1_ERROR: internal error; reference = ...`, with no
 * long-held statement behind it and every batch around them succeeding. That
 * message was not on the list, so each went out as a 500 the scraper drops
 * rather than a 503 it retries. And every failure now also lands in
 * monitoring-api's `service_events`, so a run of them is visible from this
 * side, not only from the caller's.
 */
import type { Context } from 'hono';
import { logger } from './logger.js';
import type { AppEnv } from './types.js';
import { canPostTelemetry, postServiceEvent } from './clients/telemetry.js';
import { runAfterResponse } from './background.js';

/**
 * Cloudflare's documented transient D1 errors, the ones its guidance says to
 * retry. Matched on the message, since D1 throws a plain Error with no code.
 */
const TRANSIENT_D1 = [
	'D1 DB is overloaded',
	'Network connection lost',
	'storage caused object to be reset',
	'reset because its code was updated',
	'transient issue on remote node',
	// Not on Cloudflare's list, but it is how D1 answered the 2026-10-30 burst
	// (issue #26): 39 refusals inside five seconds, nothing held the database,
	// the same batches' neighbours went through. A retry costs the caller one
	// round trip; a 500 costs it the batch. Prefixed so a non-D1 "internal
	// error" from somewhere else is not swept in.
	'D1_ERROR: internal error',
];

const RETRY_AFTER_SECONDS = 5;

function messagesOf(err: unknown): string[] {
	const out: string[] = [];
	let cur: unknown = err;
	for (let depth = 0; cur instanceof Error && depth < 4; depth++) {
		out.push(cur.message);
		cur = cur.cause;
	}
	return out;
}

export function isTransientD1Error(err: unknown): boolean {
	return messagesOf(err).some((m) => TRANSIENT_D1.some((needle) => m.includes(needle)));
}

export function errorHandler(err: Error, c: Context): Response {
	const transient = isTransientD1Error(err);
	const [message, ...causes] = messagesOf(err);
	logger.error('unhandled error', {
		method: c.req.method,
		path: c.req.path,
		name: err.name,
		message,
		causes,
		transient,
		stack: err.stack,
	});

	// One row per failure. The opening seconds of a bad scrape are ~40 of
	// these; a night like 10-17 is ~900, which is still the honest record.
	// The status is in the context so a query can tell a retried 503 from a
	// dropped 500 without parsing the message.
	// Typed here rather than in the signature: this handler is also mounted on
	// plain Hono apps in tests, which have no bindings at all.
	const env = c.env as AppEnv | undefined;
	if (canPostTelemetry(env)) {
		runAfterResponse(
			c,
			'telemetry: unhandled error',
			postServiceEvent(env, {
				level: transient ? 'warn' : 'error',
				event: 'unhandled_error',
				message: `${c.req.method} ${c.req.path} ${message ?? err.name}`,
				context: {
					method: c.req.method,
					path: c.req.path,
					status: transient ? 503 : 500,
					transient,
					message,
					causes,
				},
			})
		);
	}

	if (transient) {
		c.header('Retry-After', String(RETRY_AFTER_SECONDS));
		return c.json(
			{
				success: false,
				error: 'Service unavailable',
				message: 'The database is briefly unavailable; retry this request',
			},
			503
		);
	}
	return c.json(
		{ success: false, error: 'Internal server error', message: 'An unexpected error occurred' },
		500
	);
}
