/**
 * POST /_account/erase — the account-erase hook (hadoku_site IDENTITY_MODEL
 * R12, "Erase hooks").
 *
 *   200 → { success: true, erased: { <table>: <rows deleted> } }
 *   401 → no edge seal, or a sealed request that names nobody
 *
 * When a person deletes their account, edge-router calls this under its seal
 * (X-Edge-Auth, X-Hadoku-Tier: member, X-User-Id) and closes the account only
 * once every hook has answered its counts. The person is the edge-stamped
 * X-User-Id and nothing else: never a body field, never an ownerName (R5).
 *
 * Only the edge can reach it. edge-router 404s every inbound path with an
 * `_account` segment before routing, so no page can erase a signed-in visitor
 * with one POST through the proxy. A direct hit on the workers.dev origin
 * carries no valid seal, so createEdgeAuth degrades it to public and it is
 * refused here.
 *
 * Idempotent: every statement is a DELETE by user id, so a second call
 * matches nothing and answers zeros. The edge calls it twice by design.
 *
 * What is erased, and why it is the person's own (ERASED_TABLES below is the
 * list; erase.test.ts fails if a table with a user_id column is missing from
 * it):
 *
 *   profiles             Their scoring profiles. Each is theirs alone; a
 *                        profile is never shared.
 *   profile_companies    The companies in their profiles' slices. Deleting
 *                        them drops those boards from GET /directives unless
 *                        another person's profile also subscribes, which is
 *                        exactly what a subscription means.
 *   job_profile_rank     Derived feed ranking for their profiles. Always safe
 *   job_profile_rank_state  to delete (the feed ranks live without it); kept
 *                        would be rows for profiles that no longer exist.
 *   profile_tombstones   Their "I deleted the Default profile" markers.
 *   job_states           Their triage of each posting (and the packet slug
 *                        they sent with an application).
 *   job_events           Their application timeline: state changes, and the
 *                        notes, interviews and contacts they logged.
 *   job_feedback         Their up/down votes, one per (user, job).
 *   applications         Their apply queue. The runner writes these ON THEIR
 *                        BEHALF (ownerName), which is why the data lives here
 *                        and not in prefs-api, but every row is the person's.
 *                        A row handed to someone else (POST
 *                        /applications/:id/owner) is that person's now, and
 *                        stays.
 *   application_answers  Their standing answers to form questions, including
 *                        demographic ones.
 *   applicant_profiles   Their contact facts, education and work history.
 *   mail_reconcile_state Reconciliation of their mailbox: cursor and counts.
 *   mail_unmatched       Subjects and senders of their ATS mail.
 *   blocked_companies    The employers they hid from their feed.
 *   owner_name_cache     A STORED NAME: a cached display-name → userId
 *                        resolution. It must go, or the name keeps resolving
 *                        to an erased person for up to 15 minutes.
 *
 * Not erased: `jobs`, the shared corpus of postings, which names no person.
 * No shared table in this app records who contributed to it, so the erase
 * leaves no userId behind in shared state.
 *
 * Outside this app: the packets a variant_slug points at live in resume-api's
 * KV, and are erased (or not) by resume-api.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { tierAtLeast } from '@wolffm/worker-utils';
import type { D1Database } from '@cloudflare/workers-types';
import type { RouteContext } from './jobs/shared.js';

/** Each table this hook erases, with the DELETE that removes one person's rows. */
export const ERASED_TABLES: readonly { table: string; sql: string }[] = [
	// A profile's children first, found through the profile while it still exists.
	{
		table: 'profile_companies',
		sql: 'DELETE FROM profile_companies WHERE profile_id IN (SELECT id FROM profiles WHERE user_id = ?1)',
	},
	{
		table: 'job_profile_rank',
		sql: 'DELETE FROM job_profile_rank WHERE profile_id IN (SELECT id FROM profiles WHERE user_id = ?1)',
	},
	{
		table: 'job_profile_rank_state',
		sql: 'DELETE FROM job_profile_rank_state WHERE profile_id IN (SELECT id FROM profiles WHERE user_id = ?1)',
	},
	{ table: 'profiles', sql: 'DELETE FROM profiles WHERE user_id = ?1' },
	{ table: 'profile_tombstones', sql: 'DELETE FROM profile_tombstones WHERE user_id = ?1' },
	{ table: 'job_states', sql: 'DELETE FROM job_states WHERE user_id = ?1' },
	{ table: 'job_events', sql: 'DELETE FROM job_events WHERE user_id = ?1' },
	{ table: 'job_feedback', sql: 'DELETE FROM job_feedback WHERE user_id = ?1' },
	{ table: 'applications', sql: 'DELETE FROM applications WHERE user_id = ?1' },
	{ table: 'application_answers', sql: 'DELETE FROM application_answers WHERE user_id = ?1' },
	{ table: 'applicant_profiles', sql: 'DELETE FROM applicant_profiles WHERE user_id = ?1' },
	{ table: 'mail_reconcile_state', sql: 'DELETE FROM mail_reconcile_state WHERE user_id = ?1' },
	{ table: 'mail_unmatched', sql: 'DELETE FROM mail_unmatched WHERE user_id = ?1' },
	{ table: 'blocked_companies', sql: 'DELETE FROM blocked_companies WHERE user_id = ?1' },
	{ table: 'user_skills', sql: 'DELETE FROM user_skills WHERE user_id = ?1' },
	{ table: 'owner_name_cache', sql: 'DELETE FROM owner_name_cache WHERE user_id = ?1' },
];

/**
 * Delete every row that is this person's own, in one transaction (D1 runs a
 * batch atomically), and count what each table lost.
 */
export async function eraseUser(db: D1Database, userId: string): Promise<Record<string, number>> {
	const results = await db.batch(ERASED_TABLES.map(({ sql }) => db.prepare(sql).bind(userId)));
	const erased: Record<string, number> = {};
	ERASED_TABLES.forEach(({ table }, i) => {
		erased[table] = results[i].meta.changes;
	});
	return erased;
}

const app = new OpenAPIHono<RouteContext>();

app.post('/_account/erase', async (c) => {
	const auth = c.get('authContext');
	// createEdgeAuth has already verified the seal: without it the caller is
	// public and carries no userId, whatever headers it sent.
	if (!tierAtLeast(auth, 'member')) {
		return c.json(
			{ success: false as const, error: 'Unauthorized', message: 'Edge seal required' },
			401
		);
	}
	const userId = auth.userId?.trim();
	if (!userId) {
		return c.json(
			{ success: false as const, error: 'Unauthorized', message: 'No X-User-Id to erase' },
			401
		);
	}
	const erased = await eraseUser(c.env.JOB_PLATFORM_DB, userId);
	return c.json({ success: true as const, erased }, 200);
});

export const accountRoutes = app;
