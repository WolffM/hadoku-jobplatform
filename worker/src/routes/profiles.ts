import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { D1Database } from '@cloudflare/workers-types';
import type { AppEnv } from '../types.js';
import { requireUserType, type HadokuAuthContext } from '@wolffm/worker-utils';
import {
	CreateProfileSchema,
	UpdateProfileSchema,
	ProfilesResponseSchema,
	ProfileResponseSchema,
	DeleteResponseSchema,
	ProfileCompaniesResponseSchema,
	AddProfileCompanySchema,
	AddProfileCompanyResponseSchema,
	DeleteCompanyResponseSchema,
	ErrorResponseSchema,
} from '../schemas.js';
import { DEFAULT_PROFILE, DEFAULT_PROFILE_COMPANIES } from '../defaultProfile.js';
import { scoreProfileAgainstAllJobs, type ScorableProfile } from '../rescore.js';
import { addTargetBySlug, triggerSearch, ScraperClientError } from '../clients/scraper.js';
import { resolveUserId } from '../userId.js';
import { logger } from '../logger.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

app.use('/profiles', requireUserType(['admin', 'friend']));
app.use('/profiles/*', requireUserType(['admin', 'friend']));

// Identity for D1 row scoping. Prefers the edge-injected X-User-Id (stable
// across key rotation); falls back to the legacy credential hash only for
// non-edge callers. See userId.ts.
async function currentUserId(c: Parameters<typeof resolveUserId>[0]): Promise<string> {
	return resolveUserId(c);
}

interface ProfileFields {
	name: string;
	keywords: string[];
	role_types: string[];
	min_salary: number | null;
	remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any';
	experience_levels: string[];
}

// ── default-profile materialization ─────────────────────────────────────────

async function hasDefaultTombstone(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 FROM profile_tombstones WHERE user_id = ? AND profile_key = ?')
		.bind(userId, 'default')
		.first<{ 1: number }>();
	return row !== null;
}

/**
 * Ensure the caller has their default profile as a real row (unless they've
 * deleted it). Materializes it — profile row + seed companies — the first time,
 * atomically (the INSERT is a no-op if a default already exists, so concurrent
 * mounts can't duplicate it), then rescores it in the background so its feed
 * isn't empty. The seed companies are already-registered global scrape targets,
 * so no scraper calls are needed here.
 */
async function ensureDefaultProfile(
	c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
	db: D1Database,
	userId: string
): Promise<void> {
	if (await hasDefaultTombstone(db, userId)) return;

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const inserted = await db
		.prepare(
			`INSERT INTO profiles (id, user_id, name, keywords, target_companies, role_types, min_salary, remote_pref, experience_levels, created_at, is_default)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
			 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND is_default = 1)`
		)
		.bind(
			id,
			userId,
			DEFAULT_PROFILE.name,
			JSON.stringify(DEFAULT_PROFILE.keywords),
			'[]', // target_companies: deprecated column, kept non-null
			JSON.stringify(DEFAULT_PROFILE.role_types),
			DEFAULT_PROFILE.min_salary,
			DEFAULT_PROFILE.remote_pref,
			JSON.stringify(DEFAULT_PROFILE.experience_levels),
			now,
			userId
		)
		.run();

	if (inserted.meta.changes === 0) return; // already existed

	// Seed companies (all pre-registered global targets — no scraper calls).
	const stmts = DEFAULT_PROFILE_COMPANIES.map((co) =>
		db
			.prepare(
				`INSERT OR IGNORE INTO profile_companies (id, profile_id, ats, slug, display_name, target_id, added_at)
				 VALUES (?, ?, ?, ?, ?, NULL, ?)`
			)
			.bind(crypto.randomUUID(), id, co.ats, co.slug, co.display_name, now)
	);
	if (stmts.length) await db.batch(stmts);

	rescoreInBackground(c, db, {
		id,
		keywords: DEFAULT_PROFILE.keywords,
		role_types: DEFAULT_PROFILE.role_types,
		remote_pref: DEFAULT_PROFILE.remote_pref,
		min_salary: DEFAULT_PROFILE.min_salary,
	});
}

function rescoreInBackground(
	c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
	db: D1Database,
	profile: ScorableProfile
): void {
	const work = scoreProfileAgainstAllJobs(db, profile).catch((err) =>
		logger.error('profile rescore failed', {
			profile_id: profile.id,
			error: err instanceof Error ? err.message : String(err),
		})
	);
	// Hono's executionCtx getter throws when the runtime doesn't provide one, so
	// guard the access rather than rely on optional chaining. In the Worker it's
	// always present, keeping the background rescore alive past the response.
	try {
		c.executionCtx?.waitUntil(work);
	} catch {
		void work;
	}
}

async function ownedProfile(
	db: D1Database,
	userId: string,
	id: string
): Promise<Record<string, unknown> | null> {
	return db
		.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<Record<string, unknown>>();
}

// ============================================================================
// GET /profiles — the caller's profiles (default materialized + first)
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/profiles',
		tags: ['Profiles'],
		summary: 'List the caller’s profiles (default first, unless deleted)',
		responses: {
			200: {
				description: 'Profile list',
				content: { 'application/json': { schema: ProfilesResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		await ensureDefaultProfile(c, db, userId);

		const rows = await db
			.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_default DESC, created_at ASC')
			.bind(userId)
			.all<Record<string, unknown>>();

		return c.json({
			success: true as const,
			data: { profiles: rows.results.map(deserializeProfile) },
		});
	}
);

// ============================================================================
// POST /profiles — create a profile owned by the caller
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/profiles',
		tags: ['Profiles'],
		summary: 'Create a profile',
		request: { body: { content: { 'application/json': { schema: CreateProfileSchema } } } },
		responses: {
			201: {
				description: 'Created',
				content: { 'application/json': { schema: ProfileResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const body = c.req.valid('json');
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		await db
			.prepare(
				`INSERT INTO profiles (id, user_id, name, keywords, target_companies, role_types, min_salary, remote_pref, experience_levels, created_at)
				 VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				userId,
				body.name,
				JSON.stringify(body.keywords),
				JSON.stringify(body.role_types),
				body.min_salary,
				body.remote_pref,
				JSON.stringify(body.experience_levels),
				now
			)
			.run();

		// Score the new (still companyless) profile so its feed populates as soon
		// as companies are added.
		rescoreInBackground(c, db, {
			id,
			keywords: body.keywords,
			role_types: body.role_types,
			remote_pref: body.remote_pref,
			min_salary: body.min_salary,
		});

		const profile = { id, ...body, is_default: false, created_at: now };
		return c.json({ success: true as const, data: { profile } }, 201);
	}
);

// ============================================================================
// PUT /profiles/:id — update one of the caller’s profiles
// ============================================================================

app.openapi(
	createRoute({
		method: 'put',
		path: '/profiles/{id}',
		tags: ['Profiles'],
		summary: 'Update a profile',
		request: {
			params: z.object({ id: z.string() }),
			body: { content: { 'application/json': { schema: UpdateProfileSchema } } },
		},
		responses: {
			200: {
				description: 'Updated',
				content: { 'application/json': { schema: ProfileResponseSchema } },
			},
			404: {
				description: 'Not found',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const { id } = c.req.valid('param');
		const body = c.req.valid('json');

		const existing = await ownedProfile(db, userId, id);
		if (!existing) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Profile '${id}' not found` },
				404
			);
		}

		const merged = mergeFields(extractFields(existing), body);
		await db
			.prepare(
				`UPDATE profiles SET name=?, keywords=?, role_types=?, min_salary=?, remote_pref=?, experience_levels=? WHERE id=? AND user_id=?`
			)
			.bind(
				merged.name,
				JSON.stringify(merged.keywords),
				JSON.stringify(merged.role_types),
				merged.min_salary,
				merged.remote_pref,
				JSON.stringify(merged.experience_levels),
				id,
				userId
			)
			.run();

		// Criteria changed — rescore this profile in the background.
		rescoreInBackground(c, db, {
			id,
			keywords: merged.keywords,
			role_types: merged.role_types,
			remote_pref: merged.remote_pref,
			min_salary: merged.min_salary,
		});

		const profile = {
			id,
			...merged,
			is_default: Number(existing.is_default) === 1,
			created_at: existing.created_at as string,
		};
		return c.json({ success: true as const, data: { profile } }, 200);
	}
);

// ============================================================================
// DELETE /profiles/:id — delete a profile (tombstones the default)
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/profiles/{id}',
		tags: ['Profiles'],
		summary: 'Delete a profile (deleting the default hides it permanently)',
		request: { params: z.object({ id: z.string() }) },
		responses: {
			200: {
				description: 'Deleted',
				content: { 'application/json': { schema: DeleteResponseSchema } },
			},
			404: {
				description: 'Not found',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const { id } = c.req.valid('param');

		const existing = await ownedProfile(db, userId, id);
		if (!existing) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Profile '${id}' not found` },
				404
			);
		}

		const now = new Date().toISOString();
		await db.batch([
			db.prepare('DELETE FROM profile_companies WHERE profile_id = ?').bind(id),
			db.prepare('DELETE FROM job_profile_matches WHERE profile_id = ?').bind(id),
			db.prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?').bind(id, userId),
		]);
		// Deleting the default must persist — otherwise the next GET re-seeds it.
		if (Number(existing.is_default) === 1) {
			await db
				.prepare(
					'INSERT OR IGNORE INTO profile_tombstones (user_id, profile_key, created_at) VALUES (?, ?, ?)'
				)
				.bind(userId, 'default', now)
				.run();
		}

		return c.json({ success: true as const, data: { deleted: true as const, id } }, 200);
	}
);

// ============================================================================
// GET /profiles/:id/companies — the companies in this profile's slice
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/profiles/{profileId}/companies',
		tags: ['Profiles'],
		summary: 'List a profile’s companies',
		request: { params: z.object({ profileId: z.string() }) },
		responses: {
			200: {
				description: 'Company list',
				content: { 'application/json': { schema: ProfileCompaniesResponseSchema } },
			},
			404: {
				description: 'Profile not found',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const { profileId } = c.req.valid('param');
		if (!(await ownedProfile(db, userId, profileId))) {
			return c.json(
				{
					success: false as const,
					error: 'Not found',
					message: `Profile '${profileId}' not found`,
				},
				404
			);
		}
		const rows = await db
			.prepare(
				'SELECT id, ats, slug, display_name, added_at FROM profile_companies WHERE profile_id = ? ORDER BY added_at DESC'
			)
			.bind(profileId)
			.all<ProfileCompanyRow>();
		return c.json(
			{ success: true as const, data: { companies: rows.results.map(companyToApi) } },
			200
		);
	}
);

// ============================================================================
// POST /profiles/:id/companies — add a confirmed (ats, slug) to this profile
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/profiles/{profileId}/companies',
		tags: ['Profiles'],
		summary: 'Add a company to this profile (ensures the scrape target, triggers a scrape)',
		request: {
			params: z.object({ profileId: z.string() }),
			body: { content: { 'application/json': { schema: AddProfileCompanySchema } } },
		},
		responses: {
			201: {
				description: 'Added',
				content: { 'application/json': { schema: AddProfileCompanyResponseSchema } },
			},
			404: {
				description: 'Profile not found',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const { profileId } = c.req.valid('param');
		const { ats, slug, display_name } = c.req.valid('json');
		if (!(await ownedProfile(db, userId, profileId))) {
			return c.json(
				{
					success: false as const,
					error: 'Not found',
					message: `Profile '${profileId}' not found`,
				},
				404
			);
		}

		// Ensure the company is a live scrape target. Non-fatal on scraper error —
		// the row still persists so the user's selection isn't lost.
		let targetId: number | null = null;
		try {
			targetId = (await addTargetBySlug(c.env, ats, slug)).id;
		} catch (err) {
			logger.error('addTargetBySlug failed', {
				ats,
				slug,
				error: err instanceof ScraperClientError ? `${err.message} (${err.status})` : String(err),
			});
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.prepare(
				`INSERT OR IGNORE INTO profile_companies (id, profile_id, ats, slug, display_name, target_id, added_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(id, profileId, ats, slug, display_name, targetId, now)
			.run();

		const row = await db
			.prepare(
				'SELECT id, ats, slug, display_name, added_at FROM profile_companies WHERE profile_id = ? AND ats = ? AND slug = ?'
			)
			.bind(profileId, ats, slug)
			.first<ProfileCompanyRow>();

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
				data: { company: companyToApi(row!), search_triggered: searchTriggered },
			},
			201
		);
	}
);

// ============================================================================
// DELETE /profiles/:id/companies/:companyId — remove a company from the slice
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/profiles/{profileId}/companies/{companyId}',
		tags: ['Profiles'],
		summary: 'Remove a company from this profile',
		request: { params: z.object({ profileId: z.string(), companyId: z.string() }) },
		responses: {
			200: {
				description: 'Removed',
				content: { 'application/json': { schema: DeleteCompanyResponseSchema } },
			},
			404: {
				description: 'Not found',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const { profileId, companyId } = c.req.valid('param');
		if (!(await ownedProfile(db, userId, profileId))) {
			return c.json(
				{
					success: false as const,
					error: 'Not found',
					message: `Profile '${profileId}' not found`,
				},
				404
			);
		}
		// Leave the global scrape target running — other profiles/users may share it.
		const res = await db
			.prepare('DELETE FROM profile_companies WHERE id = ? AND profile_id = ?')
			.bind(companyId, profileId)
			.run();
		if (res.meta.changes === 0) {
			return c.json(
				{
					success: false as const,
					error: 'Not found',
					message: `Company '${companyId}' not found`,
				},
				404
			);
		}
		return c.json({ success: true as const, data: { deleted: true as const, id: companyId } }, 200);
	}
);

// ============================================================================
// Helpers
// ============================================================================

interface ProfileCompanyRow {
	id: string;
	ats: string;
	slug: string;
	display_name: string;
	added_at: string;
}

function companyToApi(r: ProfileCompanyRow) {
	return {
		id: r.id,
		ats: r.ats,
		slug: r.slug,
		display_name: r.display_name,
		added_at: r.added_at,
	};
}

function extractFields(r: Record<string, unknown>): ProfileFields {
	return {
		name: r.name as string,
		keywords: JSON.parse(r.keywords as string) as string[],
		role_types: JSON.parse(r.role_types as string) as string[],
		min_salary: r.min_salary as number | null,
		remote_pref: r.remote_pref as ProfileFields['remote_pref'],
		experience_levels: JSON.parse(r.experience_levels as string) as string[],
	};
}

function mergeFields(base: ProfileFields, body: Partial<ProfileFields>): ProfileFields {
	return {
		name: body.name ?? base.name,
		keywords: body.keywords ?? base.keywords,
		role_types: body.role_types ?? base.role_types,
		min_salary: body.min_salary !== undefined ? body.min_salary : base.min_salary,
		remote_pref: body.remote_pref ?? base.remote_pref,
		experience_levels: body.experience_levels ?? base.experience_levels,
	};
}

function deserializeProfile(r: Record<string, unknown>) {
	return {
		id: r.id as string,
		...extractFields(r),
		is_default: Number(r.is_default) === 1,
		created_at: r.created_at as string,
	};
}

export const profileRoutes = app;
