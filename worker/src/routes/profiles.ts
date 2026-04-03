import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import type { HadokuAuthContext } from '@wolffm/worker-utils';
import {
	CreateProfileSchema,
	UpdateProfileSchema,
	ProfilesResponseSchema,
	ProfileResponseSchema,
	DeleteResponseSchema,
	ErrorResponseSchema,
} from '../schemas.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// ============================================================================
// GET /profiles
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/profiles',
		tags: ['Profiles'],
		summary: 'List all profiles',
		responses: {
			200: { description: 'Profile list', content: { 'application/json': { schema: ProfilesResponseSchema } } },
		},
	}),
	async c => {
		const rows = await c.env.JOB_PLATFORM_DB.prepare(
			'SELECT * FROM profiles ORDER BY created_at ASC'
		).all<Record<string, unknown>>();

		const profiles = rows.results.map(deserializeProfile);
		return c.json({ success: true as const, data: { profiles } });
	}
);

// ============================================================================
// POST /profiles
// ============================================================================

app.openapi(
	createRoute({
		method: 'post',
		path: '/profiles',
		tags: ['Profiles'],
		summary: 'Create a profile',
		request: { body: { content: { 'application/json': { schema: CreateProfileSchema } } } },
		responses: {
			201: { description: 'Created', content: { 'application/json': { schema: ProfileResponseSchema } } },
			403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponseSchema } } },
		},
	}),
	async c => {
		const auth = c.get('authContext');
		if (auth.userType === 'public') {
			return c.json({ success: false as const, error: 'Forbidden', message: 'Authentication required' }, 403);
		}

		const body = c.req.valid('json');
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		await c.env.JOB_PLATFORM_DB.prepare(
			`INSERT INTO profiles (id, name, keywords, target_companies, role_types, min_salary, remote_pref, experience_levels, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				id,
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
// PUT /profiles/:id
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
			200: { description: 'Updated', content: { 'application/json': { schema: ProfileResponseSchema } } },
			403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponseSchema } } },
			404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
		},
	}),
	async c => {
		const auth = c.get('authContext');
		if (auth.userType === 'public') {
			return c.json({ success: false as const, error: 'Forbidden', message: 'Authentication required' }, 403);
		}

		const { id } = c.req.valid('param');
		const body = c.req.valid('json');

		const existing = await c.env.JOB_PLATFORM_DB.prepare('SELECT * FROM profiles WHERE id = ?')
			.bind(id)
			.first<Record<string, unknown>>();

		if (!existing) {
			return c.json({ success: false as const, error: 'Not found', message: `Profile '${id}' not found` }, 404);
		}

		const merged = {
			name: body.name ?? (existing.name as string),
			keywords: body.keywords ?? (JSON.parse(existing.keywords as string) as string[]),
			target_companies: body.target_companies ?? (JSON.parse(existing.target_companies as string) as string[]),
			role_types: body.role_types ?? (JSON.parse(existing.role_types as string) as string[]),
			min_salary: body.min_salary !== undefined ? body.min_salary : (existing.min_salary as number | null),
			remote_pref: body.remote_pref ?? (existing.remote_pref as 'remote' | 'hybrid' | 'onsite' | 'any'),
			experience_levels: body.experience_levels ?? (JSON.parse(existing.experience_levels as string) as string[]),
		};

		await c.env.JOB_PLATFORM_DB.prepare(
			`UPDATE profiles SET name=?, keywords=?, target_companies=?, role_types=?, min_salary=?, remote_pref=?, experience_levels=? WHERE id=?`
		)
			.bind(
				merged.name,
				JSON.stringify(merged.keywords),
				JSON.stringify(merged.target_companies),
				JSON.stringify(merged.role_types),
				merged.min_salary,
				merged.remote_pref,
				JSON.stringify(merged.experience_levels),
				id
			)
			.run();

		const profile = { id, ...merged, created_at: existing.created_at as string };
		return c.json({ success: true as const, data: { profile } }, 200);
	}
);

// ============================================================================
// DELETE /profiles/:id
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/profiles/{id}',
		tags: ['Profiles'],
		summary: 'Delete a profile',
		request: { params: z.object({ id: z.string() }) },
		responses: {
			200: { description: 'Deleted', content: { 'application/json': { schema: DeleteResponseSchema } } },
			403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponseSchema } } },
			404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
		},
	}),
	async c => {
		const auth = c.get('authContext');
		if (auth.userType !== 'admin') {
			return c.json({ success: false as const, error: 'Forbidden', message: 'Admin required' }, 403);
		}

		const { id } = c.req.valid('param');
		const existing = await c.env.JOB_PLATFORM_DB.prepare('SELECT id FROM profiles WHERE id = ?')
			.bind(id)
			.first<{ id: string }>();

		if (!existing) {
			return c.json({ success: false as const, error: 'Not found', message: `Profile '${id}' not found` }, 404);
		}

		await c.env.JOB_PLATFORM_DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
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
