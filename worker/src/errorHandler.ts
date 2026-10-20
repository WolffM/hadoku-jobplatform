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
 */
import type { Context } from 'hono';
import { logger } from './logger.js';

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
