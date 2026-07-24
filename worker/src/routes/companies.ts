import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { requireUserType, type HadokuAuthContext } from '@wolffm/worker-utils';
import {
	CompaniesResponseSchema,
	CreateCompanySchema,
	CreateCompanyResponseSchema,
	DeleteCompanyResponseSchema,
	ProbeCompanySchema,
	ProbeCompanyResponseSchema,
	MatchCompanySchema,
	MatchCompanyResponseSchema,
	ErrorResponseSchema,
} from '../schemas.js';
import {
	addTargetBySlug,
	addTargetsByName,
	deleteTarget,
	matchCompanies,
	probeSlugs,
	triggerSearch,
	ScraperClientError,
	type TargetView,
} from '../clients/scraper.js';
import { resolveUserId } from '../userId.js';
import { logger } from '../logger.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

app.use('/companies', requireUserType(['admin', 'friend']));
app.use('/companies/*', requireUserType(['admin', 'friend']));

interface UserCompanyRow {
	id: string;
	user_id: string;
	target_id: number;
	ats: string;
	slug: string;
	display_name: string;
	added_at: string;
}

function rowToApi(r: UserCompanyRow) {
	return {
		id: r.id,
		target_id: r.target_id,
		ats: r.ats,
		slug: r.slug,
		display_name: r.display_name,
		added_at: r.added_at,
	};
}

// Identity for D1 row scoping. Prefers the edge-injected X-User-Id (stable
// across key rotation); falls back to the legacy credential hash only for
// non-edge callers. See userId.ts.
async function currentUserId(c: Parameters<typeof resolveUserId>[0]): Promise<string> {
	return resolveUserId(c);
}

// ============================================================================
// GET /companies — list this user's subscribed companies
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/companies',
		tags: ['Companies'],
		summary: 'List my subscribed companies',
		responses: {
			200: {
				description: 'Company list',
				content: { 'application/json': { schema: CompaniesResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const rows = await c.env.JOB_PLATFORM_DB.prepare(
			'SELECT * FROM user_companies WHERE user_id = ? ORDER BY added_at DESC'
		)
			.bind(userId)
			.all<UserCompanyRow>();
		return c.json(
			{
				success: true as const,
				data: { companies: rows.results.map(rowToApi) },
			},
			200
		);
	}
);

// ============================================================================
// POST /companies/probe — verify explicit slugs before locking them in
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/companies/probe',
		tags: ['Companies'],
		summary: 'Probe explicit slugs to preview each provider before subscribing',
		description:
			'Read-only. Proxies to scraper /probe: for each slug, reports the company ' +
			'name (greenhouse only), open-job count, and sample titles per provider so ' +
			'the operator confirms the correct (ats, slug) before locking it in. Writes nothing.',
		request: {
			body: { content: { 'application/json': { schema: ProbeCompanySchema } } },
		},
		responses: {
			200: {
				description: 'Per-slug provider hits',
				content: { 'application/json': { schema: ProbeCompanyResponseSchema } },
			},
			502: {
				description: 'Scraper upstream error',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const { slugs, providers } = c.req.valid('json');
		try {
			const results = await probeSlugs(c.env, slugs, providers);
			return c.json({ success: true as const, data: { results } }, 200);
		} catch (err) {
			if (err instanceof ScraperClientError) {
				return c.json(
					{
						success: false as const,
						error: 'Scraper error',
						message: `${err.message} (status ${err.status})`,
					},
					502
				);
			}
			throw err;
		}
	}
);

// ============================================================================
// POST /companies/match — type a company name, get the best board to confirm
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/companies/match',
		tags: ['Companies'],
		summary: 'Match a typed company name to the best board (name-driven prefetch)',
		description:
			'Read-only. Proxies to scraper /match: for each company name, returns the ' +
			'single best board (most open jobs) with a display name, job count, sample ' +
			'titles, and a best-effort favicon domain — so the user confirms the right ' +
			'company before locking it in. Writes nothing.',
		request: {
			body: { content: { 'application/json': { schema: MatchCompanySchema } } },
		},
		responses: {
			200: {
				description: 'Per-name best match',
				content: { 'application/json': { schema: MatchCompanyResponseSchema } },
			},
			502: {
				description: 'Scraper upstream error',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const { names, providers } = c.req.valid('json');
		try {
			const results = await matchCompanies(c.env, names, providers);
			return c.json({ success: true as const, data: { results } }, 200);
		} catch (err) {
			if (err instanceof ScraperClientError) {
				return c.json(
					{
						success: false as const,
						error: 'Scraper error',
						message: `${err.message} (status ${err.status})`,
					},
					502
				);
			}
			throw err;
		}
	}
);

// ============================================================================
// POST /companies — add a company by display name, trigger scrape
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/companies',
		tags: ['Companies'],
		summary: 'Subscribe to a company by display name',
		description:
			'Two modes. (1) By name: resolves the display name to one or more ' +
			'(ats, slug) targets via scraper. (2) Verify-and-lock: when ats+slug are ' +
			'supplied, registers that exact target directly with display_name as the ' +
			'operator-confirmed company name. Either way, persists rows under the ' +
			'current user and fire-and-forget triggers a scrape across all active targets.',
		request: {
			body: { content: { 'application/json': { schema: CreateCompanySchema } } },
		},
		responses: {
			201: {
				description: 'Subscribed',
				content: { 'application/json': { schema: CreateCompanyResponseSchema } },
			},
			400: {
				description: 'No targets resolved',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
			502: {
				description: 'Scraper upstream error',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const { display_name, use_llm, ats, slug } = c.req.valid('json');
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const now = new Date().toISOString();

		let resolved: { added: TargetView[]; skipped: TargetView[] };
		try {
			if (ats && slug) {
				// Verify-and-lock: register the exact target the operator confirmed.
				const target = await addTargetBySlug(c.env, ats, slug);
				resolved = { added: [{ ...target, display_name }], skipped: [] };
			} else {
				resolved = await addTargetsByName(c.env, [display_name], { useLlm: use_llm });
			}
		} catch (err) {
			if (err instanceof ScraperClientError) {
				return c.json(
					{
						success: false as const,
						error: 'Scraper error',
						message: `${err.message} (status ${err.status})`,
					},
					502
				);
			}
			throw err;
		}

		if (resolved.added.length === 0) {
			return c.json(
				{
					success: false as const,
					error: 'No targets resolved',
					message:
						ats && slug
							? `Scraper could not register ${ats}:${slug}.`
							: `Scraper could not resolve "${display_name}" to any (ats, slug) target.`,
				},
				400
			);
		}

		const inserted: UserCompanyRow[] = [];
		for (const target of resolved.added) {
			const id = crypto.randomUUID();
			const row: UserCompanyRow = {
				id,
				user_id: userId,
				target_id: target.id,
				ats: target.ats,
				slug: target.slug,
				display_name: target.display_name ?? display_name,
				added_at: now,
			};
			// UNIQUE(user_id, target_id) — INSERT OR IGNORE so re-subscribing is a no-op
			const result = await db
				.prepare(
					`INSERT OR IGNORE INTO user_companies
					 (id, user_id, target_id, ats, slug, display_name, added_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(row.id, row.user_id, row.target_id, row.ats, row.slug, row.display_name, row.added_at)
				.run();
			if (result.meta.changes > 0) {
				inserted.push(row);
			}
		}

		// Fire-and-forget scrape trigger. Failure here shouldn't fail the request —
		// the rows are persisted; the user can manually retry or wait for a scheduled run.
		let searchTriggered = false;
		try {
			await triggerSearch(c.env);
			searchTriggered = true;
		} catch (err) {
			logger.error('triggerSearch failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		return c.json(
			{
				success: true as const,
				data: {
					companies: inserted.map(rowToApi),
					skipped: resolved.skipped.map((t) => ({ ats: t.ats, slug: t.slug })),
					search_triggered: searchTriggered,
				},
			},
			201
		);
	}
);

// ============================================================================
// DELETE /companies/:id — unsubscribe
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/companies/{id}',
		tags: ['Companies'],
		summary: 'Unsubscribe from a company',
		request: { params: z.object({ id: z.string() }) },
		responses: {
			200: {
				description: 'Deleted',
				content: { 'application/json': { schema: DeleteCompanyResponseSchema } },
			},
			404: {
				description: 'Not found',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const { id } = c.req.valid('param');
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;

		const row = await db
			.prepare('SELECT * FROM user_companies WHERE id = ? AND user_id = ?')
			.bind(id, userId)
			.first<UserCompanyRow>();

		if (!row) {
			return c.json(
				{
					success: false as const,
					error: 'Not found',
					message: `Company subscription '${id}' not found`,
				},
				404
			);
		}

		// Best-effort scraper unregister. Don't block deletion on a scraper error —
		// orphaned scraper targets are recoverable; orphaned local rows are confusing.
		try {
			await deleteTarget(c.env, row.target_id);
		} catch (err) {
			logger.error('deleteTarget failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		await db.prepare('DELETE FROM user_companies WHERE id = ?').bind(id).run();

		return c.json({ success: true as const, data: { deleted: true as const, id } }, 200);
	}
);

export const companyRoutes = app;
