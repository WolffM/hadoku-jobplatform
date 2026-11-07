/**
 * Blocked companies — employers a person never wants in their feed.
 *
 *   GET    /blocked-companies              the caller's list, newest first
 *   PUT    /blocked-companies              block one ({ company }); idempotent
 *   DELETE /blocked-companies?company=…    unblock it
 *
 * The filter itself is one NOT EXISTS in GET /jobs (feed.ts). Matching is on
 * LOWER(TRIM(company)), computed in SQL on both sides — see migration 0029.
 * Accepts `ownerName` like every per-person route, through effectiveUserId.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
	BlockCompanySchema,
	BlockedCompaniesResponseSchema,
	BlockedCompanyResponseSchema,
	IdentityErrorResponseSchema,
	UnblockCompanyResponseSchema,
} from '../../schemas.js';
import {
	effectiveUserId,
	gateAuthed,
	isEffectiveUserError,
	ownerNameQuery,
	type JobsApp,
} from './shared.js';

const ERRORS = {
	403: {
		description: 'Forbidden',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	404: {
		description: 'No such owner name',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	409: {
		description: 'That owner name has never signed in',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	503: {
		description: 'Identity could not be resolved right now — retry',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
};

interface BlockedRow {
	company: string;
	company_key: string;
	created_at: string;
}

export function registerBlockedRoutes(app: JobsApp): void {
	app.get('/blocked-companies', gateAuthed);
	app.put('/blocked-companies', gateAuthed);
	app.delete('/blocked-companies', gateAuthed);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/blocked-companies',
			tags: ['Feed'],
			summary: 'The companies the caller has blocked from their feed',
			request: { query: ownerNameQuery },
			responses: {
				200: {
					description: 'Blocked companies, newest first',
					content: { 'application/json': { schema: BlockedCompaniesResponseSchema } },
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const rows = await c.env.JOB_PLATFORM_DB.prepare(
				`SELECT company, company_key, created_at FROM blocked_companies
				 WHERE user_id = ? ORDER BY created_at DESC`
			)
				.bind(who.userId)
				.all<BlockedRow>();
			return c.json({ success: true as const, data: { companies: rows.results } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'put',
			path: '/blocked-companies',
			tags: ['Feed'],
			summary: "Block a company from the caller's feed (idempotent)",
			request: {
				query: ownerNameQuery,
				body: { content: { 'application/json': { schema: BlockCompanySchema } } },
			},
			responses: {
				200: {
					description: 'Blocked (or already was — the first spelling is kept)',
					content: { 'application/json': { schema: BlockedCompanyResponseSchema } },
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const { company } = c.req.valid('json');
			const db = c.env.JOB_PLATFORM_DB;
			const now = new Date().toISOString();
			// DO NOTHING then read back: re-blocking 'ACME' after 'Acme' keeps the
			// original row, and the answer says which one is stored.
			await db
				.prepare(
					`INSERT INTO blocked_companies (user_id, company_key, company, created_at)
					 VALUES (?1, LOWER(TRIM(?2)), TRIM(?2), ?3)
					 ON CONFLICT (user_id, company_key) DO NOTHING`
				)
				.bind(who.userId, company, now)
				.run();
			const row = await db
				.prepare(
					`SELECT company, company_key, created_at FROM blocked_companies
					 WHERE user_id = ? AND company_key = LOWER(TRIM(?))`
				)
				.bind(who.userId, company)
				.first<BlockedRow>();
			if (!row) throw new Error('blocked_companies row missing straight after its insert');
			return c.json({ success: true as const, data: { company: row } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'delete',
			path: '/blocked-companies',
			tags: ['Feed'],
			summary: 'Unblock a company',
			request: {
				query: ownerNameQuery.extend({
					company: z.string().trim().min(1).max(200).openapi({
						description: 'The company, in any case — matched the way it was blocked.',
					}),
				}),
			},
			responses: {
				200: {
					description: 'Unblocked (or was not blocked)',
					content: { 'application/json': { schema: UnblockCompanyResponseSchema } },
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const { ownerName, company } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const row = await c.env.JOB_PLATFORM_DB.prepare(
				`DELETE FROM blocked_companies WHERE user_id = ? AND company_key = LOWER(TRIM(?))
				 RETURNING company_key`
			)
				.bind(who.userId, company)
				.first<{ company_key: string }>();
			return c.json(
				{
					success: true as const,
					data: { company_key: row?.company_key ?? company.toLowerCase(), deleted: !!row },
				},
				200
			);
		}
	);
}
