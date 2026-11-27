/**
 * What the worker pulls on a run, derived from profiles the same way
 * GET /directives derives the scraper's work:
 *
 *   - one Jobsuche search per (keyword, German place) pair, for every profile
 *     whose `location` view default is a place in Germany, at that profile's
 *     radius. A profile anywhere else adds no searches: the federal job
 *     exchange only lists German postings.
 *   - one board per Personio / SmartRecruiters company: the starter list
 *     (boards.ts) plus every profile_companies row on those two ATSes.
 *
 * The order is deterministic, so `task=<n>` means the same task across the
 * calls of one sweep.
 */
import type { AppEnv } from '../types.js';
import { resolvePlace } from '../geo.js';
import { STARTER_BOARDS, WORKER_PULLED_ATS } from './boards.js';
import type { SourceTask } from './types.js';

type DB = AppEnv['JOB_PLATFORM_DB'];
type BoardTask = Exclude<SourceTask, { source: 'arbeitsagentur' }>;

/**
 * The Jobsuche `wo` for a place key, where the English name geo.ts uses would
 * resolve to the wrong place or none ("Frankfurt" alone can mean Frankfurt
 * (Oder)). Any other German place is searched by its name.
 */
const JOBSUCHE_PLACE: Record<string, string> = {
	'munich-de': 'München',
	'frankfurt-de': 'Frankfurt am Main',
	'cologne-de': 'Köln',
	'dusseldorf-de': 'Düsseldorf',
	'nuremberg-de': 'Nürnberg',
};

const MILES_TO_KM = 1.609344;
/** Jobsuche accepts any radius, but past this a "Berlin" search is most of a state. */
const MAX_RADIUS_KM = 100;

function titleCase(name: string): string {
	return name.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

function parseKeywords(raw: string | null): string[] {
	try {
		const arr = JSON.parse(raw ?? '[]') as unknown;
		return Array.isArray(arr)
			? arr
					.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
					.map((k) => k.trim())
			: [];
	} catch {
		return [];
	}
}

export function taskLabel(task: SourceTask): string {
	switch (task.source) {
		case 'arbeitsagentur':
			return `arbeitsagentur: "${task.keyword}" within ${task.radius_km} km of ${task.where}`;
		case 'personio':
			return `personio: ${task.slug}`;
		case 'smartrecruiters':
			return `smartrecruiters: ${task.company}${task.country ? ` (${task.country})` : ''}`;
	}
}

export async function buildPlan(db: DB): Promise<SourceTask[]> {
	const profiles = await db
		.prepare('SELECT keywords, location, radius_miles FROM profiles WHERE location IS NOT NULL')
		.all<{ keywords: string | null; location: string; radius_miles: number | null }>();

	// keyword (case-folded) + place -> the widest radius any profile asked for.
	const searches = new Map<string, Extract<SourceTask, { source: 'arbeitsagentur' }>>();
	for (const p of profiles.results) {
		const place = resolvePlace(p.location);
		if (!place || place.region !== 'de') continue;
		const where = JOBSUCHE_PLACE[place.key] ?? titleCase(place.name);
		const radius_km = Math.min(
			MAX_RADIUS_KM,
			Math.max(0, Math.round((p.radius_miles ?? 25) * MILES_TO_KM))
		);
		for (const keyword of parseKeywords(p.keywords)) {
			const key = `${keyword.toLowerCase()}|${where}`;
			const prev = searches.get(key);
			if (!prev || prev.radius_km < radius_km) {
				searches.set(key, {
					source: 'arbeitsagentur',
					keyword: prev?.keyword ?? keyword,
					where,
					radius_km,
				});
			}
		}
	}

	const inList = WORKER_PULLED_ATS.map(() => '?').join(',');
	const companies = await db
		.prepare(
			`SELECT ats, slug, MIN(display_name) AS display_name FROM profile_companies
			 WHERE ats IN (${inList}) GROUP BY ats, slug`
		)
		.bind(...WORKER_PULLED_ATS)
		.all<{ ats: string; slug: string; display_name: string }>();

	const boards = new Map<string, BoardTask>();
	const boardKey = (t: BoardTask) =>
		t.source === 'personio'
			? `personio|${t.slug.toLowerCase()}`
			: `smartrecruiters|${t.company.toLowerCase()}`;
	for (const t of STARTER_BOARDS) boards.set(boardKey(t), t);
	for (const row of companies.results) {
		const t: BoardTask =
			row.ats === 'personio'
				? { source: 'personio', slug: row.slug, company: row.display_name }
				: { source: 'smartrecruiters', company: row.slug, country: null };
		const key = boardKey(t);
		const starter = boards.get(key);
		// A profile asking for a whole board widens a starter entry's country filter.
		boards.set(key, starter && t.source === 'personio' ? starter : t);
	}

	const bySearch = [...searches.values()].sort(
		(a, b) => a.where.localeCompare(b.where) || a.keyword.localeCompare(b.keyword)
	);
	const byBoard = [...boards.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => t);
	return [...bySearch, ...byBoard];
}
