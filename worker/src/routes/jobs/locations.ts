/**
 * GET /locations?q= — the places the feed's near= filter knows, for a picker.
 *
 * Open, like GET /jobs: it reads nothing but the static table in geo.ts, and
 * the feed's radius filter is open too. Answers the place key the feed takes
 * and a label to show for it.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { searchPlaces } from '../../geo.js';
import type { JobsApp } from './shared.js';

const LocationSchema = z
	.object({ key: z.string(), label: z.string(), lat: z.number(), lng: z.number() })
	.openapi('Location');

/** "san francisco" / "ca" → "San Francisco, CA"; "ca-on" → "…, CA-ON". */
function label(name: string, region: string): string {
	const title = name.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
	return `${title}, ${region.toUpperCase()}`;
}

export function registerLocationsRoute(app: JobsApp): void {
	app.openapi(
		createRoute({
			method: 'get',
			path: '/locations',
			tags: ['Feed'],
			summary: 'Known places matching a prefix, for the feed’s near= filter',
			request: {
				query: z.object({
					q: z.string().trim().min(1).max(100),
					limit: z.coerce.number().int().min(1).max(25).default(10),
				}),
			},
			responses: {
				200: {
					description: 'Matches, prefix matches first',
					content: {
						'application/json': {
							schema: z
								.object({
									success: z.literal(true),
									data: z.object({ locations: z.array(LocationSchema) }),
								})
								.openapi('LocationsResponse'),
						},
					},
				},
			},
		}),
		(c) => {
			const { q, limit } = c.req.valid('query');
			const locations = searchPlaces(q, limit).map((p) => ({
				key: p.key,
				label: label(p.name, p.region),
				lat: p.lat,
				lng: p.lng,
			}));
			return c.json({ success: true as const, data: { locations } }, 200);
		}
	);
}
