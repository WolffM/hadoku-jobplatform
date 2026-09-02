import { createRoute, z } from '@hono/zod-openapi';
import { isIdentityError, resolveGranteeVia } from '@wolffm/worker-utils/identity';
import { tierAtLeast } from '@wolffm/worker-utils';
import {
	ErrorResponseSchema,
	IdentityErrorResponseSchema,
	ReassignOwnerInputSchema,
	ReassignOwnerResponseSchema,
} from '../../schemas.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

/**
 * Handing an application to someone else, BY NAME.
 *
 * The recipient is named by their registry DISPLAY NAME. The worker resolves it
 * through edge-router and stores the resulting userId, echoing the name and
 * tier back so the caller can confirm they hit the identity they meant (R4).
 *
 * THERE IS NO `userId` INPUT, and that is the whole design (R5). A userId in a
 * request body is a claim — it can be a display name someone read in a doc, or
 * a well-formed UUID belonging to nobody, and neither is distinguishable from a
 * real one without asking the registry. `{"userId": "hadoku"}` was accepted by
 * hadoku-study on 2026-08-25 and a set belonged to nobody for two days.
 *
 * WHAT MOVES, AND WHAT DELIBERATELY DOES NOT
 * ------------------------------------------
 * Seven tables in this database carry a user_id. An application is the only
 * transferable WORK ITEM among them, so a reassignment moves:
 *
 *   applications   the row itself.
 *   job_states     the same (user, job) pair, because it carries `variant_slug`
 *                  — the packet pinned to this application. Without it the new
 *                  owner holds an application the runner cannot re-fill or
 *                  submit, since the résumé PDF is fetched by that slug.
 *
 * It does NOT move, and these are refusals rather than omissions:
 *
 *   application_answers  the owner's standing answers, including the
 *                        demographic ones. Handing someone else a job must not
 *                        hand them the previous owner's private answers.
 *   profiles             scoring preferences — the person's, not the job's.
 *   profile_tombstones   a per-user "I deleted the default profile" marker.
 *   user_companies       who that person follows.
 *   job_feedback         that person's opinion of a posting.
 *
 * GIVE, DON'T TAKE. Owner-or-admin, and a caller who is neither gets the same
 * 404 as an application that does not exist, so probing reveals nothing. The
 * admin path is the escape hatch for a row owned by a userId nobody holds a key
 * for. Modelled on hadoku-study's POST /sets/{id}/owner.
 */
export function registerOwnerRoutes(app: JobsApp): void {
	app.post('/applications/:id/owner', gateAuthed);

	app.openapi(
		createRoute({
			method: 'post',
			path: '/applications/{id}/owner',
			tags: ['Applications'],
			summary: 'Hand an application to another user, named by display name',
			request: {
				params: z.object({ id: z.string() }),
				body: { content: { 'application/json': { schema: ReassignOwnerInputSchema } } },
			},
			responses: {
				200: {
					description: 'Reassigned',
					content: { 'application/json': { schema: ReassignOwnerResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				400: {
					description: 'The name was empty or otherwise unusable',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				404: {
					description: 'No such application, not yours, or no such name',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				409: {
					description: 'That name has never signed in, so it has no userId to own rows',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				503: {
					description: 'Identity could not be resolved right now — retry',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const callerId = await maybeUserId(c);
			if (!callerId) {
				return c.json(
					{ success: false as const, error: 'Forbidden', message: 'Authentication required' },
					403
				);
			}

			const { id } = c.req.valid('param');
			const { name } = c.req.valid('json');
			const db = c.env.JOB_PLATFORM_DB;
			const isAdmin = tierAtLeast(c.get('authContext'), 'admin');

			const row = await db
				.prepare('SELECT user_id, job_id FROM applications WHERE id = ?')
				.bind(id)
				.first<{ user_id: string; job_id: string }>();
			// Not yours and you are not an admin? Same answer as "no such row".
			// You can give an application away; you cannot take one.
			if (!row || (row.user_id !== callerId && !isAdmin)) {
				return c.json(
					{
						success: false as const,
						error: 'Not found',
						message: `Application '${id}' not found`,
					},
					404
				);
			}

			const resolved = await resolveGranteeVia(c.env.EDGE, {
				serviceKey: c.env.SCRAPER_USER_KEY ?? '',
				name,
			});
			if (isIdentityError(resolved)) {
				// The three codes mean genuinely different things and must not be
				// flattened. NO_REGISTRY is OUR deployment failing — reporting it
				// as "no such user" would send someone looking for a typo in a
				// name that is perfectly correct.
				// Preserve the resolver's own status. 503 in particular must not
				// become a 404: an unreachable resolver is not a missing person.
				const status = ([400, 404, 409, 503] as const).includes(resolved.status)
					? resolved.status
					: 503;
				return c.json(
					{
						success: false as const,
						error: status === 503 ? 'Unavailable' : status === 409 ? 'Conflict' : 'Not found',
						message: resolved.error,
						...(resolved.code ? { code: resolved.code } : {}),
					},
					status
				);
			}

			const now = new Date().toISOString();
			// job_states travels with it or the application arrives unusable: that
			// row holds the variant_slug the runner fetches the résumé PDF by.
			// OR REPLACE because the recipient may already have triaged this job;
			// the application's packet is the one that must survive.
			await db.batch([
				db
					.prepare('UPDATE applications SET user_id = ?, updated_at = ? WHERE id = ?')
					.bind(resolved.userId, now, id),
				db
					.prepare(
						`INSERT OR REPLACE INTO job_states (job_id, user_id, state, notes, updated_at, variant_slug)
						 SELECT job_id, ?, state, notes, ?, variant_slug
						 FROM job_states WHERE job_id = ? AND user_id = ?`
					)
					.bind(resolved.userId, now, row.job_id, row.user_id),
			]);

			return c.json(
				{
					success: true as const,
					data: {
						application_id: id,
						// The echo IS the point (R4): the caller sees which identity
						// they actually hit, for the one change they cannot undo alone.
						grantedTo: { name: resolved.name, tier: resolved.tier ?? null },
					},
				},
				200
			);
		}
	);
}
