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
	ErrorResponseSchema,
} from '../schemas.js';
import {
	DEFAULT_PROFILE,
	DEFAULT_PROFILE_ID,
	DEFAULT_PROFILE_CREATED_AT,
} from '../defaultProfile.js';
import { resolveUserId } from '../userId.js';

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
	target_companies: string[];
	role_types: string[];
	min_salary: number | null;
	remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any';
	experience_levels: string[];
}

async function hasDefaultTombstone(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 FROM profile_tombstones WHERE user_id = ? AND profile_key = ?')
		.bind(userId, DEFAULT_PROFILE_ID)
		.first<{ 1: number }>();
	return row !== null;
}

async function defaultCopyRow(
	db: D1Database,
	userId: string
): Promise<Record<string, unknown> | null> {
	return db
		.prepare('SELECT * FROM profiles WHERE user_id = ? AND is_default = 1')
		.bind(userId)
		.first<Record<string, unknown>>();
}

// ============================================================================
// GET /profiles — the caller's profiles, with the shared default injected first
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/profiles',
		tags: ['Profiles'],
		summary: 'List the caller’s profiles (default profile first, unless deleted)',
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

		const [rows, tombstoned] = await Promise.all([
			db
				.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC')
				.bind(userId)
				.all<Record<string, unknown>>(),
			hasDefaultTombstone(db, userId),
		]);

		// The copy-on-write default row (if any) is presented under the reserved
		// id 'default', not its real uuid; regular rows follow.
		const copyRow = rows.results.find((r) => Number(r.is_default) === 1) ?? null;
		const regular = rows.results
			.filter((r) => Number(r.is_default) !== 1)
			.map((r) => deserializeProfile(r, false));

		const profiles = [];
		if (!tombstoned) {
			profiles.push(copyRow ? deserializeDefault(copyRow) : seedDefaultProfile());
		}
		profiles.push(...regular);

		return c.json({ success: true as const, data: { profiles } });
	}
);

// ============================================================================
// PUT /profiles/default — edit the shared default (copy-on-write per user)
// Registered before /profiles/{id} so the reserved key wins.
// ============================================================================

app.openapi(
	createRoute({
		method: 'put',
		path: '/profiles/default',
		tags: ['Profiles'],
		summary: 'Edit the shared default profile (copies it into a per-user row)',
		request: { body: { content: { 'application/json': { schema: UpdateProfileSchema } } } },
		responses: {
			200: {
				description: 'Updated',
				content: { 'application/json': { schema: ProfileResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const body = c.req.valid('json');

		const existing = await defaultCopyRow(db, userId);
		const base: ProfileFields = existing ? extractFields(existing) : { ...DEFAULT_PROFILE };
		const merged = mergeFields(base, body);

		if (existing) {
			await db
				.prepare(
					`UPDATE profiles SET name=?, keywords=?, target_companies=?, role_types=?, min_salary=?, remote_pref=?, experience_levels=? WHERE id=? AND user_id=?`
				)
				.bind(
					merged.name,
					JSON.stringify(merged.keywords),
					JSON.stringify(merged.target_companies),
					JSON.stringify(merged.role_types),
					merged.min_salary,
					merged.remote_pref,
					JSON.stringify(merged.experience_levels),
					existing.id as string,
					userId
				)
				.run();
		} else {
			// Copy-on-write: materialize the seed into a real per-user row.
			const id = crypto.randomUUID();
			const now = new Date().toISOString();
			await db
				.prepare(
					`INSERT INTO profiles (id, user_id, name, keywords, target_companies, role_types, min_salary, remote_pref, experience_levels, created_at, is_default)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
				)
				.bind(
					id,
					userId,
					merged.name,
					JSON.stringify(merged.keywords),
					JSON.stringify(merged.target_companies),
					JSON.stringify(merged.role_types),
					merged.min_salary,
					merged.remote_pref,
					JSON.stringify(merged.experience_levels),
					now
				)
				.run();
		}

		// Editing resurrects a previously-deleted default.
		await db
			.prepare('DELETE FROM profile_tombstones WHERE user_id = ? AND profile_key = ?')
			.bind(userId, DEFAULT_PROFILE_ID)
			.run();

		const profile = {
			id: DEFAULT_PROFILE_ID,
			...merged,
			created_at: DEFAULT_PROFILE_CREATED_AT,
			is_default: true,
		};
		return c.json({ success: true as const, data: { profile } }, 200);
	}
);

// ============================================================================
// DELETE /profiles/default — hide the default for this user (tombstone)
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/profiles/default',
		tags: ['Profiles'],
		summary: 'Delete the shared default for this user (persists — it will not reappear)',
		responses: {
			200: {
				description: 'Deleted',
				content: { 'application/json': { schema: DeleteResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const db = c.env.JOB_PLATFORM_DB;
		const now = new Date().toISOString();

		await db
			.prepare('DELETE FROM profiles WHERE user_id = ? AND is_default = 1')
			.bind(userId)
			.run();
		await db
			.prepare(
				'INSERT OR IGNORE INTO profile_tombstones (user_id, profile_key, created_at) VALUES (?, ?, ?)'
			)
			.bind(userId, DEFAULT_PROFILE_ID, now)
			.run();

		return c.json(
			{ success: true as const, data: { deleted: true as const, id: DEFAULT_PROFILE_ID } },
			200
		);
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
		const body = c.req.valid('json');
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		await c.env.JOB_PLATFORM_DB.prepare(
			`INSERT INTO profiles (id, user_id, name, keywords, target_companies, role_types, min_salary, remote_pref, experience_levels, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				id,
				userId,
				body.name,
				JSON.stringify(body.keywords),
				JSON.stringify(body.target_companies),
				JSON.stringify(body.role_types),
				body.min_salary,
				body.remote_pref,
				JSON.stringify(body.experience_levels),
				now
			)
			.run();

		const profile = { id, ...body, created_at: now, is_default: false };
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
		const { id } = c.req.valid('param');
		const body = c.req.valid('json');

		const existing = await c.env.JOB_PLATFORM_DB.prepare(
			'SELECT * FROM profiles WHERE id = ? AND user_id = ?'
		)
			.bind(id, userId)
			.first<Record<string, unknown>>();

		if (!existing) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Profile '${id}' not found` },
				404
			);
		}

		const merged = mergeFields(extractFields(existing), body);

		await c.env.JOB_PLATFORM_DB.prepare(
			`UPDATE profiles SET name=?, keywords=?, target_companies=?, role_types=?, min_salary=?, remote_pref=?, experience_levels=? WHERE id=? AND user_id=?`
		)
			.bind(
				merged.name,
				JSON.stringify(merged.keywords),
				JSON.stringify(merged.target_companies),
				JSON.stringify(merged.role_types),
				merged.min_salary,
				merged.remote_pref,
				JSON.stringify(merged.experience_levels),
				id,
				userId
			)
			.run();

		const profile = {
			id,
			...merged,
			created_at: existing.created_at as string,
			is_default: Number(existing.is_default) === 1,
		};
		return c.json({ success: true as const, data: { profile } }, 200);
	}
);

// ============================================================================
// DELETE /profiles/:id — delete one of the caller’s profiles
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/profiles/{id}',
		tags: ['Profiles'],
		summary: 'Delete a profile',
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
		const { id } = c.req.valid('param');

		const existing = await c.env.JOB_PLATFORM_DB.prepare(
			'SELECT id FROM profiles WHERE id = ? AND user_id = ?'
		)
			.bind(id, userId)
			.first<{ id: string }>();

		if (!existing) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Profile '${id}' not found` },
				404
			);
		}

		await c.env.JOB_PLATFORM_DB.prepare('DELETE FROM profiles WHERE id = ? AND user_id = ?')
			.bind(id, userId)
			.run();
		return c.json({ success: true as const, data: { deleted: true as const, id } }, 200);
	}
);

// ============================================================================
// Helpers
// ============================================================================

function extractFields(r: Record<string, unknown>): ProfileFields {
	return {
		name: r.name as string,
		keywords: JSON.parse(r.keywords as string) as string[],
		target_companies: JSON.parse(r.target_companies as string) as string[],
		role_types: JSON.parse(r.role_types as string) as string[],
		min_salary: r.min_salary as number | null,
		remote_pref: r.remote_pref as ProfileFields['remote_pref'],
		experience_levels: JSON.parse(r.experience_levels as string) as string[],
	};
}

/** Merge a partial update (PUT semantics) over a base; undefined keeps base. */
function mergeFields(base: ProfileFields, body: Partial<ProfileFields>): ProfileFields {
	return {
		name: body.name ?? base.name,
		keywords: body.keywords ?? base.keywords,
		target_companies: body.target_companies ?? base.target_companies,
		role_types: body.role_types ?? base.role_types,
		min_salary: body.min_salary !== undefined ? body.min_salary : base.min_salary,
		remote_pref: body.remote_pref ?? base.remote_pref,
		experience_levels: body.experience_levels ?? base.experience_levels,
	};
}

function deserializeProfile(r: Record<string, unknown>, isDefault: boolean) {
	return {
		id: r.id as string,
		...extractFields(r),
		created_at: r.created_at as string,
		is_default: isDefault,
	};
}

/** A copy-on-write default row, presented under the reserved id 'default'. */
function deserializeDefault(r: Record<string, unknown>) {
	return {
		id: DEFAULT_PROFILE_ID,
		...extractFields(r),
		created_at: r.created_at as string,
		is_default: true,
	};
}

/** The code-seeded default, for users who haven't edited or deleted it. */
function seedDefaultProfile() {
	return {
		id: DEFAULT_PROFILE_ID,
		...DEFAULT_PROFILE,
		created_at: DEFAULT_PROFILE_CREATED_AT,
		is_default: true,
	};
}

export const profileRoutes = app;
