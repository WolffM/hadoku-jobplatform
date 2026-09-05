import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { D1Database } from '@cloudflare/workers-types';
import type { AppEnv } from '../types.js';
import { requireMinTier, tierAtLeast, type HadokuAuthContext } from '@wolffm/worker-utils';
import { isIdentityError, resolveGranteeVia } from '@wolffm/worker-utils/identity';
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
import { loadScorableProfile, type ProfileTrack } from '../profileScore.js';
import type { RoleLevel } from '../roleClassify.js';
import { triggerSearch } from '../clients/scraper.js';
import { NoIdentityError, resolveUserId } from '../userId.js';
import { logger } from '../logger.js';
import { clearRank, scheduleRankBuild } from '../rank.js';
import { runAfterResponse, type HasExecutionCtx } from '../background.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: {
		authContext: HadokuAuthContext;
		/**
		 * Set by `requireIdentity` when a service caller named an owner. Every
		 * route reads identity through `currentUserId`, so stashing it here
		 * reaches all of them without touching a single call site.
		 */
		ownerUserId?: string;
	};
}

const app = new OpenAPIHono<RouteContext>();

app.use('/profiles', requireMinTier('friend'));
app.use('/profiles/*', requireMinTier('friend'));

/**
 * Every route below scopes its rows to the caller, so a caller with no
 * established identity has no rows to scope to — a 401, not a 500.
 *
 * The tier gate above is not the same check. `requireMinTier` says the caller
 * presented a key good enough to be here; this says edge-router resolved that
 * key to somebody. They come apart for a legacy registry row that has never
 * been assigned a userId: it authenticates, and it cannot own anything (R2).
 */
app.use('/profiles', requireIdentity);
app.use('/profiles/*', requireIdentity);

async function requireIdentity(
	c: {
		req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
		json: (b: unknown, s?: 401 | 403 | 404 | 409 | 503) => Response;
		get: (k: 'authContext') => HadokuAuthContext;
		set: (k: 'ownerUserId', v: string) => void;
		env: AppEnv;
	},
	next: () => Promise<void>
) {
	if (!c.req.header('X-User-Id')?.trim()) {
		return c.json(
			{
				success: false,
				error: 'Unauthorized',
				message: new NoIdentityError().message,
			},
			401
		);
	}

	// `?owner=<display name>` — act as that person instead of the caller.
	//
	// Resolved HERE rather than inside `currentUserId` because this is the
	// layer that can already return a response. Doing it deeper would mean
	// throwing from a helper seven routes call, and an identity refusal would
	// surface as a 500 instead of the 403/404/409/503 it actually is.
	const owner = c.req.query('owner')?.trim();
	if (owner) {
		// SERVICE OR ADMIN ONLY. A friend-tier caller is a signed-in human in a
		// browser; letting one pass a name would make every profile route a way
		// to read and edit somebody else's companies and scoring.
		if (!tierAtLeast(c.get('authContext'), 'service')) {
			return c.json(
				{
					success: false,
					error: 'Forbidden',
					message: 'Only a service or admin caller may act on behalf of a named owner.',
				},
				403
			);
		}
		const resolved = await resolveGranteeVia(c.env.EDGE, {
			serviceKey: c.env.SCRAPER_USER_KEY ?? '',
			name: owner,
		});
		if (isIdentityError(resolved)) {
			const status = ([404, 409, 503] as const).includes(resolved.status as 404 | 409 | 503)
				? (resolved.status as 404 | 409 | 503)
				: 503;
			return c.json(
				{
					success: false,
					error: status === 503 ? 'Unavailable' : status === 409 ? 'Conflict' : 'Not found',
					message: resolved.error,
					...(resolved.code ? { code: resolved.code } : {}),
				},
				status
			);
		}
		c.set('ownerUserId', resolved.userId);
	}

	await next();
}

// Identity for D1 row scoping: the edge-injected X-User-Id, which is stable
// across key rotation and is the only thing that establishes who is calling
// (R1). There is no fallback — see userId.ts for why the credential hash that
// used to be one was worse than an error.
async function currentUserId(
	c: Parameters<typeof resolveUserId>[0] & { get?: (k: 'ownerUserId') => string | undefined }
): Promise<string> {
	// An owner named on the request wins, having already been RESOLVED against
	// the registry by `requireIdentity` — never a string off the request (R5).
	const onBehalfOf = c.get?.('ownerUserId');
	if (onBehalfOf) return onBehalfOf;
	return resolveUserId(c);
}

// Fire a scrape now (fire-and-forget) so a just-added directive — a company or
// a keyword — is picked up promptly instead of waiting for the daily cron. The
// scraper's /search is a 202; we don't block the response on its result.
//
// This did nothing at all until 2026-09-05: it guarded the executionCtx getter
// with a bare catch, and the host worker was forwarding (request, env) without
// a context, so every call landed in that catch and the promise was dropped.
// runAfterResponse says so out loud instead.
function triggerSearchBg(c: HasExecutionCtx, env: AppEnv): void {
	runAfterResponse(c, 'triggerSearch', triggerSearch(env));
}

interface ProfileFields {
	name: string;
	keywords: string[];
	track: ProfileTrack;
	levels: RoleLevel[];
	remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any';
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
 * mounts can't duplicate it). The seed companies are already-registered global
 * scrape targets, so no scraper calls are needed here. Scores are computed on
 * read (see jobs.ts), so there's nothing to precompute.
 */
async function ensureDefaultProfile(db: D1Database, userId: string): Promise<void> {
	if (await hasDefaultTombstone(db, userId)) return;

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const inserted = await db
		.prepare(
			`INSERT INTO profiles (id, user_id, name, keywords, target_companies, track, levels, remote_pref, created_at, is_default)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
			 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND is_default = 1)`
		)
		.bind(
			id,
			userId,
			DEFAULT_PROFILE.name,
			JSON.stringify(DEFAULT_PROFILE.keywords),
			'[]', // target_companies: deprecated column, kept non-null
			DEFAULT_PROFILE.track,
			JSON.stringify(DEFAULT_PROFILE.levels),
			DEFAULT_PROFILE.remote_pref,
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
		await ensureDefaultProfile(db, userId);

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
				`INSERT INTO profiles (id, user_id, name, keywords, target_companies, track, levels, remote_pref, created_at)
				 VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)`
			)
			.bind(
				id,
				userId,
				body.name,
				JSON.stringify(body.keywords),
				body.track,
				JSON.stringify(body.levels),
				body.remote_pref,
				now
			)
			.run();

		// New keywords are a scrape directive — kick a scrape so they populate
		// without waiting for the daily cron.
		if (body.keywords.length > 0) triggerSearchBg(c, c.env);

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

		const base = extractFields(existing);
		const merged = mergeFields(base, body);
		await db
			.prepare(
				`UPDATE profiles SET name=?, keywords=?, track=?, levels=?, remote_pref=? WHERE id=? AND user_id=?`
			)
			.bind(
				merged.name,
				JSON.stringify(merged.keywords),
				merged.track,
				JSON.stringify(merged.levels),
				merged.remote_pref,
				id,
				userId
			)
			.run();

		// If the keyword set changed, those are new scrape directives — kick a
		// scrape so they populate without waiting for the daily cron.
		if (JSON.stringify(merged.keywords) !== JSON.stringify(base.keywords)) {
			triggerSearchBg(c, c.env);
		}

		// The saved criteria are what the precomputed ranking was built from, so
		// it is now void. rankIsCurrent notices on its own — the stored criteria
		// hash no longer matches — so the feed is already safe; this just rebuilds
		// it behind the response rather than leaving the next viewer to pay for a
		// live pass. Editing a profile is a deliberate act by someone plainly
		// using it, so unlike the feed's lazy build there is nothing to wait for.
		scheduleRankBuild(c, db, id, await loadScorableProfile(db, id));

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
			db.prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?').bind(id, userId),
		]);
		// job_profile_rank is keyed by profile, and its foreign key is on job_id —
		// so nothing else would ever collect these rows.
		await clearRank(db, id);
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

		// No push to the scraper here — companies are a scrape directive now.
		// The scraper pulls GET /directives (the union of every profile's
		// companies + keywords) each run and registers them itself, so the
		// selection just needs to persist; triggerSearch below makes it immediate.
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.prepare(
				`INSERT OR IGNORE INTO profile_companies (id, profile_id, ats, slug, display_name, target_id, added_at)
				 VALUES (?, ?, ?, ?, ?, NULL, ?)`
			)
			.bind(id, profileId, ats, slug, display_name, now)
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
		track: r.track as ProfileTrack,
		levels: JSON.parse(r.levels as string) as RoleLevel[],
		remote_pref: r.remote_pref as ProfileFields['remote_pref'],
	};
}

function mergeFields(base: ProfileFields, body: Partial<ProfileFields>): ProfileFields {
	return {
		name: body.name ?? base.name,
		keywords: body.keywords ?? base.keywords,
		track: body.track ?? base.track,
		levels: body.levels ?? base.levels,
		remote_pref: body.remote_pref ?? base.remote_pref,
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
