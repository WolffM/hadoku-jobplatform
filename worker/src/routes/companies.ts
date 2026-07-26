import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { requireMinTier, type HadokuAuthContext } from '@wolffm/worker-utils';
import {
	ProbeCompanySchema,
	ProbeCompanyResponseSchema,
	MatchCompanySchema,
	MatchCompanyResponseSchema,
	ErrorResponseSchema,
} from '../schemas.js';
import { matchCompanies, probeSlugs, ScraperClientError } from '../clients/scraper.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// Company lookups — read-only helpers behind the profile "add company" flow.
// Actual subscriptions live per-profile under /profiles/:id/companies.
app.use('/companies/*', requireMinTier('friend'));

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
			'company before adding it to a profile. Writes nothing.',
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
// POST /companies/probe — verify explicit slugs (advanced / power-user path)
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/companies/probe',
		tags: ['Companies'],
		summary: 'Probe explicit slugs to preview each provider before adding',
		description:
			'Read-only. Proxies to scraper /probe: for each slug, reports the company ' +
			'name (greenhouse only), open-job count, and sample titles per provider. ' +
			'Writes nothing.',
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

export const companyRoutes = app;
