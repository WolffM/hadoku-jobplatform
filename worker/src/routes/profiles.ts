import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
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

// ============================================================================
// GET /profiles — list the caller's own profiles
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/profiles',
		tags: ['Profiles'],
		summary: 'List the caller’s profiles',
		responses: {
			200: {
				description: 'Profile list',
				content: { 'application/json': { schema: ProfilesResponseSchema } },
			},
		},
	}),
	async (c) => {
		const userId = await currentUserId(c);
		const rows = await c.env.JOB_PLATFORM_DB.prepare(
			'SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC'
		)
			.bind(userId)
			.all<Record<string, unknown>>();

		const profiles = rows.results.map(deserializeProfile);
		return c.json({ success: true as const, data: { profiles } });
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

		const profile = { id, ...body, created_at: now };
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

		const merged = {
			name: body.name ?? (existing.name as string),
			keywords: body.keywords ?? (JSON.parse(existing.keywords as string) as string[]),
			target_companies:
				body.target_companies ?? (JSON.parse(existing.target_companies as string) as string[]),
			role_types: body.role_types ?? (JSON.parse(existing.role_types as string) as string[]),
			min_salary:
				body.min_salary !== undefined ? body.min_salary : (existing.min_salary as number | null),
			remote_pref:
				body.remote_pref ?? (existing.remote_pref as 'remote' | 'hybrid' | 'onsite' | 'any'),
			experience_levels:
				body.experience_levels ?? (JSON.parse(existing.experience_levels as string) as string[]),
		};

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

		const profile = { id, ...merged, created_at: existing.created_at as string };
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

function deserializeProfile(r: Record<string, unknown>) {
	return {
		id: r.id as string,
		name: r.name as string,
		keywords: JSON.parse(r.keywords as string) as string[],
		target_companies: JSON.parse(r.target_companies as string) as string[],
		role_types: JSON.parse(r.role_types as string) as string[],
		min_salary: r.min_salary as number | null,
		remote_pref: r.remote_pref as 'remote' | 'hybrid' | 'onsite' | 'any',
		experience_levels: JSON.parse(r.experience_levels as string) as string[],
		created_at: r.created_at as string,
	};
}

export const profileRoutes = app;
