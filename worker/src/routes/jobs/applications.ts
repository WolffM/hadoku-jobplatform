import { createRoute, z } from '@hono/zod-openapi';
import {
	ApplicationsResponseSchema,
	ApplicationResponseSchema,
	ApplicationStatusSchema,
	ApplyRequestSchema,
	ErrorResponseSchema,
	SetApplicationStatusSchema,
} from '../../schemas.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

/**
 * The approve-to-apply queue (issue #15).
 *
 * POST /jobs/:id/apply queues one application per (user, job) for the PC-side
 * form runner; the human clicking Apply IS the consent step. The runner drains
 * the queue and reports transitions through POST /applications/:id/status
 * (service-tier clears the same friend-min gate). In review mode the runner
 * pauses at 'filled' until the owner hits POST /applications/:id/approve.
 *
 * Queueing requires a minted packet: the caller's job_states row must carry a
 * variant_slug, which is copied onto the application row so a later re-tailor
 * cannot silently change what an in-flight application sends.
 */

interface ApplicationRow {
	id: string;
	job_id: string;
	variant_slug: string;
	mode: string;
	status: string;
	error: string | null;
	evidence: string | null;
	created_at: string;
	updated_at: string;
}

// D1 hands evidence back as the TEXT blob the runner posted; parse it for the
// response, degrading to null rather than 500ing on a hand-written bad blob.
function parseEvidence(raw: string | null): Record<string, unknown> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function toApplication(row: ApplicationRow) {
	return {
		id: row.id,
		job_id: row.job_id,
		variant_slug: row.variant_slug,
		mode: row.mode as 'review' | 'auto',
		status: row.status as
			| 'queued'
			| 'filled'
			| 'approved'
			| 'submitted'
			| 'needs_manual'
			| 'failed',
		error: row.error,
		evidence: parseEvidence(row.evidence),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

const FORBIDDEN = {
	success: false as const,
	error: 'Forbidden',
	message: 'Authentication required',
};

export function registerApplicationRoutes(app: JobsApp): void {
	app.post('/jobs/:id/apply', gateAuthed);
	app.get('/applications', gateAuthed);
	app.post('/applications/:id/status', gateAuthed);
	app.post('/applications/:id/approve', gateAuthed);

	// ==========================================================================
	// POST /jobs/{id}/apply — queue (or re-queue) an application
	// ==========================================================================
	app.openapi(
		createRoute({
			method: 'post',
			path: '/jobs/{id}/apply',
			tags: ['Applications'],
			summary: 'Queue this job for the form runner (requires a minted packet)',
			request: {
				params: z.object({ id: z.string() }),
				body: {
					content: { 'application/json': { schema: ApplyRequestSchema } },
					required: false,
				},
			},
			responses: {
				200: {
					description: 'Application queued',
					content: { 'application/json': { schema: ApplicationResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'Job not found',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				409: {
					description: 'No packet minted for this job',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);

			const { id } = c.req.valid('param');
			// Body is optional; zod-openapi validates {} for a body-less POST, which
			// skips schema defaults — so the 'review' default lives here.
			const body = c.req.valid('json') as { mode?: 'review' | 'auto' } | undefined;
			const mode = body?.mode ?? 'review';
			const db = c.env.JOB_PLATFORM_DB;

			const job = await db
				.prepare('SELECT id FROM jobs WHERE id = ?')
				.bind(id)
				.first<{ id: string }>();
			if (!job) {
				return c.json(
					{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
					404
				);
			}

			const state = await db
				.prepare('SELECT variant_slug FROM job_states WHERE user_id = ? AND job_id = ?')
				.bind(userId, id)
				.first<{ variant_slug: string | null }>();
			if (!state?.variant_slug) {
				return c.json(
					{
						success: false as const,
						error: 'Conflict',
						message:
							`No application packet for job '${id}' — prepare the application ` +
							'first so a resume variant is minted, then apply.',
					},
					409
				);
			}

			// Re-apply re-queues: status back to 'queued', error/evidence cleared,
			// mode and the packet slug refreshed. created_at marks first queueing.
			const now = new Date().toISOString();
			await db
				.prepare(
					`INSERT INTO applications
					   (id, user_id, job_id, variant_slug, mode, status, error, evidence, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)
					 ON CONFLICT (user_id, job_id) DO UPDATE SET
					   variant_slug = excluded.variant_slug,
					   mode = excluded.mode,
					   status = 'queued',
					   error = NULL,
					   evidence = NULL,
					   updated_at = excluded.updated_at`
				)
				.bind(crypto.randomUUID(), userId, id, state.variant_slug, mode, now, now)
				.run();

			const row = await db
				.prepare('SELECT * FROM applications WHERE user_id = ? AND job_id = ?')
				.bind(userId, id)
				.first<ApplicationRow>();
			// The upsert above guarantees the row; a miss here is a real bug.
			if (!row) throw new Error(`application row missing after upsert (job '${id}')`);

			return c.json({ success: true as const, data: { application: toApplication(row) } }, 200);
		}
	);

	// ==========================================================================
	// GET /applications — the caller's queue, joined with the jobs
	// ==========================================================================
	app.openapi(
		createRoute({
			method: 'get',
			path: '/applications',
			tags: ['Applications'],
			summary: "List the caller's queued applications, newest first",
			request: {
				query: z.object({ status: ApplicationStatusSchema.optional() }),
			},
			responses: {
				200: {
					description: 'Applications, newest first',
					content: { 'application/json': { schema: ApplicationsResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);

			const { status } = c.req.valid('query');
			const filter = status ? ' AND a.status = ?' : '';
			const stmt = c.env.JOB_PLATFORM_DB.prepare(
				`SELECT a.id, a.job_id, a.variant_slug, a.mode, a.status, a.error,
				        a.evidence, a.created_at, a.updated_at,
				        j.title, j.company, j.location
				 FROM applications a
				 INNER JOIN jobs j ON j.id = a.job_id
				 WHERE a.user_id = ?${filter}
				 ORDER BY a.updated_at DESC`
			);
			const rows = await (status ? stmt.bind(userId, status) : stmt.bind(userId)).all<
				ApplicationRow & { title: string; company: string; location: string }
			>();

			const applications = rows.results.map((r) => ({
				...toApplication(r),
				title: r.title,
				company: r.company,
				location: r.location,
			}));

			return c.json({ success: true as const, data: { applications } }, 200);
		}
	);

	// ==========================================================================
	// POST /applications/{id}/status — the runner's transition endpoint
	// ==========================================================================
	app.openapi(
		createRoute({
			method: 'post',
			path: '/applications/{id}/status',
			tags: ['Applications'],
			summary: 'Record a status transition (runner endpoint; loose for v1)',
			request: {
				params: z.object({ id: z.string() }),
				body: { content: { 'application/json': { schema: SetApplicationStatusSchema } } },
			},
			responses: {
				200: {
					description: 'Status recorded',
					content: { 'application/json': { schema: ApplicationResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'Application not found',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);

			const { id } = c.req.valid('param');
			const body = c.req.valid('json');
			const db = c.env.JOB_PLATFORM_DB;

			// Scoped to the caller: another user's application id 404s, not 403s,
			// so ids don't leak existence.
			const existing = await db
				.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?')
				.bind(id, userId)
				.first<ApplicationRow>();
			if (!existing) {
				return c.json(
					{
						success: false as const,
						error: 'Not found',
						message: `Application '${id}' not found`,
					},
					404
				);
			}

			// Any → any is accepted for v1 (the runner is trusted); error always
			// reflects THIS transition (omitted → cleared), evidence is sticky
			// (omitted → kept) so a bare transition never wipes screenshots.
			const now = new Date().toISOString();
			const evidence =
				body.evidence !== undefined ? JSON.stringify(body.evidence) : existing.evidence;
			await db
				.prepare(
					`UPDATE applications SET status = ?, error = ?, evidence = ?, updated_at = ?
					 WHERE id = ?`
				)
				.bind(body.status, body.error ?? null, evidence, now, id)
				.run();

			return c.json(
				{
					success: true as const,
					data: {
						application: toApplication({
							...existing,
							status: body.status,
							error: body.error ?? null,
							evidence,
							updated_at: now,
						}),
					},
				},
				200
			);
		}
	);

	// ==========================================================================
	// POST /applications/{id}/approve — the review-mode go-ahead
	// ==========================================================================
	app.openapi(
		createRoute({
			method: 'post',
			path: '/applications/{id}/approve',
			tags: ['Applications'],
			summary: 'Approve a filled application for submission (review-mode pause point)',
			request: { params: z.object({ id: z.string() }) },
			responses: {
				200: {
					description: 'Approved — the runner will submit',
					content: { 'application/json': { schema: ApplicationResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'Application not found',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				409: {
					description: "Not in 'filled' — nothing to approve",
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) return c.json(FORBIDDEN, 403);

			const { id } = c.req.valid('param');
			const db = c.env.JOB_PLATFORM_DB;

			const existing = await db
				.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?')
				.bind(id, userId)
				.first<ApplicationRow>();
			if (!existing) {
				return c.json(
					{
						success: false as const,
						error: 'Not found',
						message: `Application '${id}' not found`,
					},
					404
				);
			}

			// Approval only means something at the review-mode pause point: the
			// runner has filled the form and is waiting on the owner's screenshot
			// check. Approving anything else would be a no-op at best and a
			// double-submit at worst.
			if (existing.status !== 'filled') {
				return c.json(
					{
						success: false as const,
						error: 'Conflict',
						message: `Application '${id}' is '${existing.status}', not 'filled' — only a filled application can be approved`,
					},
					409
				);
			}

			const now = new Date().toISOString();
			await db
				.prepare(`UPDATE applications SET status = 'approved', updated_at = ? WHERE id = ?`)
				.bind(now, id)
				.run();

			return c.json(
				{
					success: true as const,
					data: {
						application: toApplication({ ...existing, status: 'approved', updated_at: now }),
					},
				},
				200
			);
		}
	);
}
