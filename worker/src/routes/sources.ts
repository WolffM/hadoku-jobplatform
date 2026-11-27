/**
 * GET / POST /ingest/sources: the job sources this worker pulls itself
 * (src/sources/), next to the boards the scraper posts to POST /ingest.
 *
 * The scraper covers Greenhouse, Lever, Ashby, LinkedIn and the remote-job
 * keyword boards, which leaves Germany thin: in November 2026 the corpus held
 * about 700 onsite or hybrid postings within 25 miles of Berlin, most from one
 * employer. These sources are public, documented and keyless, so pulling them
 * needs no browser and no credential, and a worker can do it directly.
 *
 * One task per call, like /ingest/cull and /ingest/rebuild-rank: a sweep calls
 * `POST /ingest/sources?task=0` and follows `next_task` until it is null. A
 * failing source answers 200 with `error` set and moves on, so one board that
 * is down never stops the sweep.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireMinTier, type HadokuAuthContext } from '@wolffm/worker-utils';
import type { AppEnv } from '../types.js';
import { recordEvent } from '../opEvents.js';
import { buildPlan, taskLabel } from '../sources/plan.js';
import { runTask } from '../sources/run.js';
import { SourceFetchError } from '../sources/types.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// friend and up, like every other /ingest/* operator route; tiers rank, so the
// sweep's service key is admitted.
app.use('/ingest/sources', requireMinTier('friend'));

const TaskSchema = z
	.object({
		source: z.string(),
		label: z.string(),
		keyword: z.string().optional(),
		where: z.string().optional(),
		radius_km: z.number().optional(),
		slug: z.string().optional(),
		company: z.string().optional(),
		country: z.string().nullable().optional(),
	})
	.openapi('SourceTask');

const planRoute = createRoute({
	method: 'get',
	path: '/ingest/sources',
	tags: ['Ingest'],
	summary: 'The tasks a source pull runs, in order (read-only)',
	responses: {
		200: {
			description: 'The plan',
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.literal(true),
							data: z.object({ tasks: z.array(TaskSchema) }),
						})
						.openapi('SourcePlanResponse'),
				},
			},
		},
	},
});

app.openapi(planRoute, async (c) => {
	const tasks = await buildPlan(c.env.JOB_PLATFORM_DB);
	return c.json(
		{
			success: true as const,
			data: { tasks: tasks.map((t) => ({ ...t, label: taskLabel(t) })) },
		},
		200
	);
});

const runRoute = createRoute({
	method: 'post',
	path: '/ingest/sources',
	tags: ['Ingest'],
	summary: 'Run one task of the source pull; repeat with next_task until it is null',
	request: {
		query: z.object({
			task: z.coerce
				.number()
				.int()
				.min(0)
				.default(0)
				.openapi({ description: 'Index into GET /ingest/sources' }),
		}),
	},
	responses: {
		200: {
			description: 'Task run (or the plan was exhausted)',
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.literal(true),
							data: z.object({
								task: z.number(),
								tasks_total: z.number(),
								label: z.string().nullable(),
								listed: z.number(),
								accepted: z.number(),
								already_known: z.number(),
								details_fetched: z.number(),
								details_failed: z.number(),
								deferred: z.number(),
								error: z.string().nullable(),
								next_task: z.number().nullable(),
							}),
						})
						.openapi('SourceRunResponse'),
				},
			},
		},
	},
});

app.openapi(runRoute, async (c) => {
	const { task: index } = c.req.valid('query');
	const db = c.env.JOB_PLATFORM_DB;
	const tasks = await buildPlan(db);
	const empty = {
		listed: 0,
		accepted: 0,
		already_known: 0,
		details_fetched: 0,
		details_failed: 0,
		deferred: 0,
	};
	const task = tasks[index];
	if (!task) {
		return c.json(
			{
				success: true as const,
				data: {
					task: index,
					tasks_total: tasks.length,
					label: null,
					...empty,
					error: null,
					next_task: null,
				},
			},
			200
		);
	}

	const label = taskLabel(task);
	const following = index + 1 < tasks.length ? index + 1 : null;
	const ctx = {
		http: (url: string, init?: Parameters<typeof fetch>[1]) => fetch(url, init),
		baseOverride: c.env.JOB_SOURCES_BASE_URL,
	};
	try {
		const { again, ...result } = await runTask(db, task, ctx);
		recordEvent(c, {
			level: 'info',
			event: 'ingest.sources',
			message: `${label}: ${result.accepted} new of ${result.listed}`,
			context: { task: index, source: task.source, ...result },
		});
		return c.json(
			{
				success: true as const,
				data: {
					task: index,
					tasks_total: tasks.length,
					label,
					...result,
					error: null,
					next_task: again ? index : following,
				},
			},
			200
		);
	} catch (err) {
		// A source that is down or changed its format is that task's problem
		// only. Anything else (D1 above all) is ours and goes to onError.
		if (!(err instanceof SourceFetchError)) throw err;
		recordEvent(c, {
			level: 'warn',
			event: 'ingest.sources',
			message: `${label}: ${err.message}`,
			context: { task: index, source: task.source, status: err.status },
		});
		return c.json(
			{
				success: true as const,
				data: {
					task: index,
					tasks_total: tasks.length,
					label,
					...empty,
					error: err.message,
					next_task: following,
				},
			},
			200
		);
	}
});

export { app as sourceRoutes };
