/**
 * A person's skills list, and how a posting measures against it.
 *
 *   GET    /skills              the caller's skills, by name
 *   POST   /skills              add one ({ name, category?, proficiency? }); 409 when it is already there
 *   DELETE /skills/:id          remove one
 *   GET    /jobs/:id/match      the posting's skills (skills.ts vocabulary over title +
 *                               description) against the caller's list, falling back to
 *                               their profiles' `stack` when the list is empty
 *
 * Skills are matched on the vocabulary's canonical name, so "K8s" in the list
 * meets "Kubernetes" in a posting. This is a view for the person, like
 * GET /insights' skill demand — scoring does not read it.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
	ErrorResponseSchema,
	IdentityErrorResponseSchema,
	JobMatchResponseSchema,
	SkillResponseSchema,
	SkillsResponseSchema,
	AddSkillSchema,
} from '../../schemas.js';
import { canonicalSkill, extractSkills, parseStringList } from '../../skills.js';
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
		description: 'Not found, or no such owner name',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	409: {
		description: 'Already in the list, or that owner name has never signed in',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	503: {
		description: 'Identity could not be resolved right now — retry',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
};

const SKILL_COLS = 'id, name, category, proficiency, created_at';

interface SkillRow {
	id: number;
	name: string;
	category: string | null;
	proficiency: 'beginner' | 'intermediate' | 'expert';
	created_at: string;
}

export function registerUserSkillRoutes(app: JobsApp): void {
	app.get('/skills', gateAuthed);
	app.post('/skills', gateAuthed);
	app.delete('/skills/:id', gateAuthed);
	app.get('/jobs/:id/match', gateAuthed);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/skills',
			tags: ['Profile'],
			summary: "The caller's skills list",
			request: { query: ownerNameQuery },
			responses: {
				200: {
					description: 'Skills, by name',
					content: { 'application/json': { schema: SkillsResponseSchema } },
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const rows = await c.env.JOB_PLATFORM_DB.prepare(
				`SELECT ${SKILL_COLS} FROM user_skills WHERE user_id = ? ORDER BY name COLLATE NOCASE`
			)
				.bind(who.userId)
				.all<SkillRow>();
			return c.json({ success: true as const, data: { skills: rows.results } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'post',
			path: '/skills',
			tags: ['Profile'],
			summary: "Add a skill to the caller's list",
			request: {
				query: ownerNameQuery,
				body: { content: { 'application/json': { schema: AddSkillSchema } } },
			},
			responses: {
				201: {
					description: 'Added',
					content: { 'application/json': { schema: SkillResponseSchema } },
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const { name, category, proficiency } = c.req.valid('json');
			const db = c.env.JOB_PLATFORM_DB;
			const res = await db
				.prepare(
					`INSERT INTO user_skills (user_id, name, name_key, category, proficiency, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT (user_id, name_key) DO NOTHING`
				)
				.bind(
					who.userId,
					name,
					canonicalSkill(name),
					category ?? null,
					proficiency,
					new Date().toISOString()
				)
				.run();
			if ((res.meta?.changes ?? 0) === 0) {
				return c.json(
					{
						success: false as const,
						error: 'Conflict',
						message: `${name} is already in your skills.`,
					},
					409
				);
			}
			const row = await db
				.prepare(`SELECT ${SKILL_COLS} FROM user_skills WHERE user_id = ? AND name_key = ?`)
				.bind(who.userId, canonicalSkill(name))
				.first<SkillRow>();
			return c.json({ success: true as const, data: { skill: row! } }, 201);
		}
	);

	app.openapi(
		createRoute({
			method: 'delete',
			path: '/skills/{id}',
			tags: ['Profile'],
			summary: "Remove a skill from the caller's list",
			request: {
				params: z.object({ id: z.coerce.number().int().positive() }),
				query: ownerNameQuery,
			},
			responses: {
				200: {
					description: 'Removed',
					content: {
						'application/json': {
							schema: z.object({
								success: z.literal(true),
								data: z.object({ deleted: z.boolean() }),
							}),
						},
					},
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const res = await c.env.JOB_PLATFORM_DB.prepare(
				'DELETE FROM user_skills WHERE id = ? AND user_id = ?'
			)
				.bind(c.req.valid('param').id, who.userId)
				.run();
			if ((res.meta?.changes ?? 0) === 0) {
				return c.json(
					{ success: false as const, error: 'Not found', message: 'No such skill in your list.' },
					404
				);
			}
			return c.json({ success: true as const, data: { deleted: true } }, 200);
		}
	);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/jobs/{id}/match',
			tags: ['Jobs'],
			summary: "Which of a posting's skills the caller has, and which they lack",
			request: { params: z.object({ id: z.string() }), query: ownerNameQuery },
			responses: {
				200: {
					description: 'The match',
					content: { 'application/json': { schema: JobMatchResponseSchema } },
				},
				...ERRORS,
				400: {
					description: 'Bad request',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const db = c.env.JOB_PLATFORM_DB;
			const job = await db
				.prepare('SELECT title, description FROM jobs WHERE id = ?')
				.bind(c.req.valid('param').id)
				.first<{ title: string; description: string }>();
			if (!job) {
				return c.json(
					{ success: false as const, error: 'Not found', message: 'No such posting.' },
					404
				);
			}
			const detected = extractSkills(`${job.title}\n${job.description}`);

			const listed = await db
				.prepare('SELECT name_key FROM user_skills WHERE user_id = ?')
				.bind(who.userId)
				.all<{ name_key: string }>();
			let against: 'skills' | 'profile_stack' | 'none' = 'skills';
			let mine = new Set(listed.results.map((r) => r.name_key));
			if (mine.size === 0) {
				const stacks = await db
					.prepare('SELECT stack FROM profiles WHERE user_id = ?')
					.bind(who.userId)
					.all<{ stack: string }>();
				mine = new Set(stacks.results.flatMap((p) => parseStringList(p.stack).map(canonicalSkill)));
				against = mine.size > 0 ? 'profile_stack' : 'none';
			}

			const matched = detected.filter((s) => mine.has(s));
			const missing = detected.filter((s) => !mine.has(s));
			const score =
				detected.length === 0 ? 0 : Math.round((100 * matched.length) / detected.length);
			const summary =
				detected.length === 0
					? 'This posting names none of the skills the matcher knows.'
					: against === 'none'
						? `This posting asks for ${detected.length} skill${detected.length === 1 ? '' : 's'}; add yours to see how you match.`
						: `You have ${matched.length} of the ${detected.length} skill${detected.length === 1 ? '' : 's'} this posting names.`;
			return c.json(
				{
					success: true as const,
					data: { matched, missing, detected, score, summary, against },
				},
				200
			);
		}
	);
}
