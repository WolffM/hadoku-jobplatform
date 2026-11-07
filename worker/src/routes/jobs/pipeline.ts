/**
 * V5 — what happens to an application after it is sent.
 *
 *   GET    /pipeline                     every posting in the caller's pipeline
 *   PATCH  /jobs/{id}/tracking           notes, priority, follow-up date, contact
 *   GET    /jobs/{id}/events             that posting's timeline, oldest first
 *   POST   /jobs/{id}/events             log a note / interview / contact / follow-up
 *   DELETE /jobs/{id}/events/{eventId}   remove one the person wrote
 *
 * A posting is IN the pipeline exactly when the person has a job_states row for
 * it (migration 0028 explains why the tracking lives on that row). So every
 * route here but GET /pipeline answers 409 for a posting with no state: there
 * is nothing to track until the person has said where it stands, and saying so
 * is PUT /jobs/{id}/state, which also writes the timeline's 'state' rows.
 *
 * All five accept `ownerName` like the rest of the per-user routes, through
 * `effectiveUserId` — never silently ignored (see AGENTS.md).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { D1Database } from '@cloudflare/workers-types';
import {
	AddJobEventSchema,
	asJobStateRead,
	IdentityErrorResponseSchema,
	JobEventResponseSchema,
	JobEventsResponseSchema,
	PipelineResponseSchema,
	SetTrackingSchema,
	TrackingResponseSchema,
	type JobStateValue,
} from '../../schemas.js';
import {
	asApplicationStatus,
	effectiveUserId,
	gateAuthed,
	isEffectiveUserError,
	ownerNameQuery,
	type JobsApp,
} from './shared.js';

const IDENTITY_ERRORS = {
	404: {
		description: 'No such owner name, or no such job',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	409: {
		description: 'That owner name has never signed in, or the posting is not in the pipeline',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	503: {
		description: 'Identity could not be resolved right now — retry',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
};

// IdentityErrorResponseSchema, not ErrorResponseSchema: effectiveUserId's own
// 403 (a caller not allowed to name an owner) carries a `code` as well.
const FORBIDDEN = {
	description: 'Forbidden',
	content: { 'application/json': { schema: IdentityErrorResponseSchema } },
};

interface EventRow {
	id: number;
	job_id: string;
	kind: string;
	from_state: string | null;
	to_state: string | null;
	note: string | null;
	occurred_at: string;
	created_at: string;
}

export interface TrackingRow {
	notes: string | null;
	priority: number | null;
	follow_up_at: string | null;
	contact_name: string | null;
	contact_email: string | null;
}

const EVENT_COLS = 'id, job_id, kind, from_state, to_state, note, occurred_at, created_at';
export const TRACKING_COLS = 'notes, priority, follow_up_at, contact_name, contact_email';

/** A stored state that this code no longer writes reads as null, not as a bogus enum. */
function stateOrNull(v: string | null): JobStateValue | null {
	const s = asJobStateRead(v);
	return s === 'new' ? null : s;
}

function toEvent(r: EventRow) {
	return {
		...r,
		kind: r.kind as 'state' | 'note' | 'interview' | 'contact' | 'follow_up',
		from_state: stateOrNull(r.from_state),
		to_state: stateOrNull(r.to_state),
	};
}

function asPriority(p: number | null): 1 | 2 | 3 | null {
	return p === 1 || p === 2 || p === 3 ? p : null;
}

export function toTracking(r: TrackingRow) {
	return {
		notes: r.notes,
		priority: asPriority(r.priority),
		follow_up_at: r.follow_up_at,
		contact_name: r.contact_name,
		contact_email: r.contact_email,
	};
}

function notInPipeline(id: string) {
	return {
		success: false as const,
		error: 'Conflict',
		message: `Job '${id}' is not in your pipeline — set its state first (PUT /jobs/${id}/state)`,
	};
}

function jobNotFound(id: string) {
	return { success: false as const, error: 'Not found', message: `Job '${id}' not found` };
}

/** 'missing' — no such job; 'untracked' — a job, but no state for this person. */
async function stateOf(
	db: D1Database,
	jobId: string,
	userId: string
): Promise<'missing' | 'untracked' | 'tracked'> {
	const row = await db
		.prepare(
			`SELECT j.id, js.state FROM jobs j
			 LEFT JOIN job_states js ON js.job_id = j.id AND js.user_id = ?
			 WHERE j.id = ?`
		)
		.bind(userId, jobId)
		.first<{ id: string; state: string | null }>();
	if (!row) return 'missing';
	return row.state ? 'tracked' : 'untracked';
}

export function registerPipelineRoutes(app: JobsApp): void {
	app.get('/pipeline', gateAuthed);
	app.patch('/jobs/:id/tracking', gateAuthed);
	app.get('/jobs/:id/events', gateAuthed);
	app.post('/jobs/:id/events', gateAuthed);
	app.delete('/jobs/:id/events/:eventId', gateAuthed);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/pipeline',
			tags: ['Pipeline'],
			summary: "Every posting in the caller's pipeline, most recently changed first",
			request: {
				query: ownerNameQuery.extend({
					include_dismissed: z.enum(['true', 'false']).optional().openapi({
						description: 'Dismissed postings are left out unless this is true.',
					}),
				}),
			},
			responses: {
				200: {
					description: 'Pipeline',
					content: { 'application/json': { schema: PipelineResponseSchema } },
				},
				403: FORBIDDEN,
				...IDENTITY_ERRORS,
			},
		}),
		async (c) => {
			const { ownerName, include_dismissed } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const dismissed = include_dismissed === 'true' ? '' : "AND js.state != 'dismissed'";
			// The two timeline facts are correlated subqueries over
			// idx_job_events_job, one seek per row, rather than a GROUP BY join:
			// a pipeline is tens of rows, and this keeps the outer query a plain
			// walk of idx_job_states_user.
			const rows = await c.env.JOB_PLATFORM_DB.prepare(
				`SELECT js.job_id, j.title, j.company, j.location, j.workplace_type,
				        j.salary_min, j.salary_max, j.url, j.posted_date,
				        js.state, js.updated_at, js.variant_slug,
				        js.notes, js.priority, js.follow_up_at, js.contact_name, js.contact_email,
				        ap.status AS application_status,
				        (SELECT MIN(e.occurred_at) FROM job_events e
				          WHERE e.job_id = js.job_id AND e.user_id = js.user_id
				            AND e.kind = 'state' AND e.to_state = 'applied') AS applied_at,
				        (SELECT MAX(e.occurred_at) FROM job_events e
				          WHERE e.job_id = js.job_id AND e.user_id = js.user_id) AS last_event_at
				 FROM job_states js
				 JOIN jobs j ON j.id = js.job_id
				 LEFT JOIN applications ap ON ap.job_id = js.job_id AND ap.user_id = js.user_id
				 WHERE js.user_id = ? ${dismissed}
				 ORDER BY js.updated_at DESC`
			)
				.bind(who.userId)
				.all<
					TrackingRow & {
						job_id: string;
						title: string;
						company: string;
						location: string;
						workplace_type: string;
						salary_min: number | null;
						salary_max: number | null;
						url: string;
						posted_date: string | null;
						state: string;
						updated_at: string;
						variant_slug: string | null;
						application_status: string | null;
						applied_at: string | null;
						last_event_at: string | null;
					}
				>();
			const items = rows.results.flatMap((r) => {
				const state = stateOrNull(r.state);
				// A state this code does not know is not a pipeline column; leaving
				// it out beats inventing one for it.
				if (!state) return [];
				return [
					{
						job_id: r.job_id,
						title: r.title,
						company: r.company,
						location: r.location,
						workplace_type: r.workplace_type,
						salary_min: r.salary_min,
						salary_max: r.salary_max,
						url: r.url,
						posted_date: r.posted_date,
						state,
						updated_at: r.updated_at,
						tracking: toTracking(r),
						variant_slug: r.variant_slug,
						application_status: asApplicationStatus(r.application_status),
						applied_at: r.applied_at,
						last_event_at: r.last_event_at,
					},
				];
			});
			return c.json({ success: true as const, data: { items } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'patch',
			path: '/jobs/{id}/tracking',
			tags: ['Pipeline'],
			summary: 'Change what the caller tracks about one application; null clears a field',
			request: {
				params: z.object({ id: z.string() }),
				query: ownerNameQuery,
				body: { content: { 'application/json': { schema: SetTrackingSchema } } },
			},
			responses: {
				200: {
					description: 'Tracking after the change',
					content: { 'application/json': { schema: TrackingResponseSchema } },
				},
				403: FORBIDDEN,
				...IDENTITY_ERRORS,
			},
		}),
		async (c) => {
			const { id } = c.req.valid('param');
			const { ownerName } = c.req.valid('query');
			const body = c.req.valid('json');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const db = c.env.JOB_PLATFORM_DB;

			// Only the fields the body names; undefined leaves a column alone and
			// null clears it. The column names come from this fixed list, never
			// from the body.
			const sets: string[] = [];
			const binds: (string | number | null)[] = [];
			for (const col of [
				'notes',
				'priority',
				'follow_up_at',
				'contact_name',
				'contact_email',
			] as const) {
				const v = body[col];
				if (v === undefined) continue;
				sets.push(`${col} = ?`);
				// An emptied text box is a cleared field, not an empty string.
				binds.push(typeof v === 'string' && v.trim() === '' ? null : v);
			}
			const now = new Date().toISOString();
			const row = await db
				.prepare(
					`UPDATE job_states SET ${sets.join(', ')}, updated_at = ?
					 WHERE job_id = ? AND user_id = ?
					 RETURNING ${TRACKING_COLS}`
				)
				.bind(...binds, now, id, who.userId)
				.first<TrackingRow>();
			if (!row) {
				const s = await stateOf(db, id, who.userId);
				return s === 'missing' ? c.json(jobNotFound(id), 404) : c.json(notInPipeline(id), 409);
			}
			return c.json(
				{ success: true as const, data: { job_id: id, tracking: toTracking(row) } },
				200
			);
		}
	);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/jobs/{id}/events',
			tags: ['Pipeline'],
			summary: "One posting's timeline for the caller, oldest first",
			request: { params: z.object({ id: z.string() }), query: ownerNameQuery },
			responses: {
				200: {
					description: 'Timeline (empty for a posting with none)',
					content: { 'application/json': { schema: JobEventsResponseSchema } },
				},
				403: FORBIDDEN,
				...IDENTITY_ERRORS,
			},
		}),
		async (c) => {
			const { id } = c.req.valid('param');
			const { ownerName } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const rows = await c.env.JOB_PLATFORM_DB.prepare(
				`SELECT ${EVENT_COLS} FROM job_events
				 WHERE job_id = ? AND user_id = ?
				 ORDER BY occurred_at, id`
			)
				.bind(id, who.userId)
				.all<EventRow>();
			return c.json({ success: true as const, data: { events: rows.results.map(toEvent) } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'post',
			path: '/jobs/{id}/events',
			tags: ['Pipeline'],
			summary: 'Log something that happened on one application',
			request: {
				params: z.object({ id: z.string() }),
				query: ownerNameQuery,
				body: { content: { 'application/json': { schema: AddJobEventSchema } } },
			},
			responses: {
				201: {
					description: 'Logged',
					content: { 'application/json': { schema: JobEventResponseSchema } },
				},
				403: FORBIDDEN,
				...IDENTITY_ERRORS,
			},
		}),
		async (c) => {
			const { id } = c.req.valid('param');
			const { ownerName } = c.req.valid('query');
			const body = c.req.valid('json');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const db = c.env.JOB_PLATFORM_DB;

			const s = await stateOf(db, id, who.userId);
			if (s === 'missing') return c.json(jobNotFound(id), 404);
			if (s === 'untracked') return c.json(notInPipeline(id), 409);

			const now = new Date().toISOString();
			// A bare date is that day in UTC; stored in full ISO form so the
			// timeline sorts as one string.
			const occurred = body.occurred_at
				? new Date(
						body.occurred_at.length === 10 ? `${body.occurred_at}T00:00:00Z` : body.occurred_at
					).toISOString()
				: now;
			const row = await db
				.prepare(
					`INSERT INTO job_events
					   (job_id, user_id, kind, from_state, to_state, note, occurred_at, created_at)
					 VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
					 RETURNING ${EVENT_COLS}`
				)
				.bind(id, who.userId, body.kind, body.note, occurred, now)
				.first<EventRow>();
			if (!row) throw new Error('job_events INSERT … RETURNING returned no row');
			return c.json({ success: true as const, data: { event: toEvent(row) } }, 201);
		}
	);

	app.openapi(
		createRoute({
			method: 'delete',
			path: '/jobs/{id}/events/{eventId}',
			tags: ['Pipeline'],
			summary: 'Remove a note/interview/contact/follow-up the caller logged',
			request: {
				params: z.object({ id: z.string(), eventId: z.coerce.number().int().positive() }),
				query: ownerNameQuery,
			},
			responses: {
				200: {
					description: 'Removed (or already absent)',
					content: {
						'application/json': {
							schema: z
								.object({
									success: z.literal(true),
									data: z.object({ id: z.number().int(), deleted: z.boolean() }),
								})
								.openapi('DeleteJobEventResponse'),
						},
					},
				},
				403: FORBIDDEN,
				...IDENTITY_ERRORS,
			},
		}),
		async (c) => {
			const { id, eventId } = c.req.valid('param');
			const { ownerName } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			// kind != 'state': a transition is the record of what the person did
			// with PUT /state, and the way to change it is another transition.
			const res = await c.env.JOB_PLATFORM_DB.prepare(
				`DELETE FROM job_events
				 WHERE id = ? AND job_id = ? AND user_id = ? AND kind != 'state'`
			)
				.bind(eventId, id, who.userId)
				.run();
			return c.json(
				{ success: true as const, data: { id: eventId, deleted: (res.meta?.changes ?? 0) > 0 } },
				200
			);
		}
	);
}
