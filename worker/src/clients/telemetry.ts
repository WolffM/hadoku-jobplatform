/**
 * Posting a row to monitoring-api's `service_events`.
 *
 * Workers Logs needs an account token to read; `service_events` is readable
 * with this repo's own service key (`GET /health/api/service-events?service=jobplatform`).
 * So a failure we want noticed goes here as well as to the logger. Issue #26:
 * three nights of ingest 500s were visible only from the scraper's side.
 *
 * Reached over the EDGE binding as this worker's service identity, like the
 * mail feed and resume-api: a plain fetch to hadoku.me from inside the zone
 * skips edge-router and lands on the origin.
 */
import { MONITORING_BASE } from '@wolffm/worker-utils/edge-routes';
import type { AppEnv } from '../types.js';

export const TELEMETRY_SERVICE = 'jobplatform';

export interface ServiceEvent {
	level: 'info' | 'warn' | 'error';
	/** Lands in the `event` column; keep it short and stable, it is what gets grouped by. */
	event: string;
	message: string;
	context?: Record<string, unknown>;
}

/** True when this worker has what posting needs. Callers skip the post when it doesn't. */
export function canPostTelemetry(env: AppEnv | undefined): env is AppEnv {
	return Boolean(env?.EDGE && env.HADOKU_SERVICE_KEY?.trim());
}

/** Resolves when monitoring-api has accepted the row; rejects with the reason it didn't. */
export async function postServiceEvent(env: AppEnv, ev: ServiceEvent): Promise<void> {
	const key = env.HADOKU_SERVICE_KEY?.trim();
	if (!env.EDGE || !key) throw new Error('EDGE binding or HADOKU_SERVICE_KEY not configured');
	const res = await env.EDGE.fetch(`${MONITORING_BASE}/api/telemetry`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-User-Key': key,
		},
		body: JSON.stringify({
			source: 'worker',
			level: ev.level,
			type: 'log',
			message: `event=${ev.event} ${ev.message}`,
			context: { ...ev.context, service: TELEMETRY_SERVICE },
		}),
	});
	if (!res.ok) throw new Error(`monitoring-api answered ${res.status}`);
}
