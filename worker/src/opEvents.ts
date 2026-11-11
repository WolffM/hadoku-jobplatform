/**
 * One `service_events` row per operation whose OUTCOME a request row cannot show.
 *
 * edge-router already logs every call to this worker (`request_logs`: method,
 * path, status, user, time). What it cannot see is what the call DID: how many
 * postings a batch added, which state a click set, which way an application
 * moved. Those are posted here, after the response, as `service=jobplatform`
 * rows named `<area>.<verb>` (`ingest.batch`, `job.state`, `application.status`).
 *
 * Fire and forget by design: telemetry never fails or slows the operation it
 * describes. A post that fails is logged by runAfterResponse; it is not retried.
 */
import { runAfterResponse, type HasExecutionCtx } from './background.js';
import { canPostTelemetry, postServiceEvent, type ServiceEvent } from './clients/telemetry.js';
import type { AppEnv } from './types.js';

export function recordEvent(c: HasExecutionCtx, ev: ServiceEvent): void {
	const env = c.env as AppEnv | undefined;
	if (!canPostTelemetry(env)) return;
	runAfterResponse(c, `telemetry: ${ev.event}`, postServiceEvent(env, ev));
}

/**
 * Routes that post their own, richer event (above): the middleware below
 * leaves them alone rather than writing a second row for one operation.
 * Matched against the path after the API base.
 */
const OWN_EVENT = [
	/^\/ingest(\/cull|\/rebuild-rank|\/reconcile-mail)?$/,
	/^\/telemetry$/,
	/^\/jobs\/import$/,
	/^\/jobs\/[^/]+\/(state|apply|resume|cover-letter|packet-link|application-extras)$/,
	/^\/applications\/[^/]+\/(status|approve|owner)$/,
	/^\/_account\/erase$/,
];

/**
 * Body fields whose VALUE is worth a row: short, structural, never free text.
 * Everything else is reported by name only, so notes, answers and résumé text
 * never reach the log.
 */
const VALUE_FIELDS = new Set([
	'state',
	'direction',
	'reason',
	'axis',
	'company',
	'name',
	'category',
	'proficiency',
	'ats',
	'slug',
	'priority',
	'kind',
	'track',
	'is_default',
]);

function summarize(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
	const values: Record<string, unknown> = {};
	const fields: string[] = [];
	for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
		fields.push(k);
		if (!VALUE_FIELDS.has(k)) continue;
		if (typeof v === 'string') values[k] = v.slice(0, 80);
		else if (typeof v === 'number' || typeof v === 'boolean' || v === null) values[k] = v;
	}
	return { fields: fields.slice(0, 30), ...values };
}

interface ChangeContext extends HasExecutionCtx {
	req: { method: string; path: string; json(): Promise<unknown>; query(): Record<string, string> };
	res: { status: number };
	get(key: 'authContext'): { userId?: string | null; userType?: string } | undefined;
}

/**
 * Every POST / PUT / PATCH / DELETE without an event of its own gets one
 * `api.change` row: which route, what it answered, who, and the shape of what
 * they sent. Mounted once, so a route added later is covered without touching it.
 */
export function changeEvents(base: string) {
	return async (c: ChangeContext, next: () => Promise<void>): Promise<void> => {
		await next();
		const method = c.req.method;
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
		const path = c.req.path.startsWith(base) ? c.req.path.slice(base.length) || '/' : c.req.path;
		if (OWN_EVENT.some((re) => re.test(path))) return;
		const status = c.res.status;
		// Hono caches the parsed body, so this reads what the validator already read.
		// A DELETE names its target in the query (`?company=`), the others in the body.
		const body = method === 'DELETE' ? c.req.query() : await c.req.json().catch(() => null);
		const auth = c.get('authContext');
		recordEvent(c, {
			level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
			event: 'api.change',
			message: `${method} ${path} ${status}`,
			context: {
				method,
				path,
				status,
				user_id: auth?.userId ?? null,
				tier: auth?.userType ?? 'public',
				...summarize(body),
			},
		});
	};
}
