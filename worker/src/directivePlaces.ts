/**
 * The `places` part of GET /directives: each profile's home place, its radius
 * and its keywords, so the scraper can search a profile's keywords around that
 * profile's own place (the Jobsuche feed searches German places only).
 *
 * A profile is listed when its `location` resolves to a known place and it has
 * at least one keyword. Profiles that resolve to the same place and radius are
 * merged into one entry, their keywords unioned case-insensitively (first-seen
 * casing kept, like the top-level `keywords`). The raw location string is never
 * sent, only the resolved place.
 */
import { placeCountry, resolvePlace } from './geo.js';

export interface DirectivePlace {
	/** The place's name, title-cased ("Berlin", "New York City"). */
	name: string;
	/** ISO 3166-1 alpha-2, lowercase ("de", "us"). */
	country: string;
	radius_miles: number;
	keywords: string[];
}

export interface DirectivePlaceRow {
	location: string | null;
	radius_miles: number | null;
	keywords: string | null;
}

/** The radius a profile gets when none is stored (the profiles default). */
const DEFAULT_RADIUS_MILES = 25;

function titleCase(name: string): string {
	return name.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** A profile's keywords column (a JSON array of strings), trimmed; anything else is none. */
export function parseKeywordList(raw: string | null): string[] {
	let arr: unknown;
	try {
		arr = JSON.parse(raw ?? '[]');
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	return arr.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k !== '');
}

export function directivePlaces(rows: DirectivePlaceRow[]): DirectivePlace[] {
	const byKey = new Map<string, { place: DirectivePlace; seen: Set<string> }>();
	for (const row of rows) {
		if (!row.location) continue;
		const place = resolvePlace(row.location);
		if (!place) continue;
		const keywords = parseKeywordList(row.keywords);
		if (keywords.length === 0) continue;
		const radius =
			typeof row.radius_miles === 'number' && Number.isFinite(row.radius_miles)
				? Math.max(0, row.radius_miles)
				: DEFAULT_RADIUS_MILES;
		const key = `${place.key}|${radius}`;
		let entry = byKey.get(key);
		if (!entry) {
			entry = {
				place: {
					name: titleCase(place.name),
					country: placeCountry(place),
					radius_miles: radius,
					keywords: [],
				},
				seen: new Set(),
			};
			byKey.set(key, entry);
		}
		for (const kw of keywords) {
			const folded = kw.toLowerCase();
			if (entry.seen.has(folded)) continue;
			entry.seen.add(folded);
			entry.place.keywords.push(kw);
		}
	}
	// Deterministic order: by place key, then radius.
	return [...byKey.entries()]
		.sort(([a], [b]) => {
			const [ka, ra] = a.split('|');
			const [kb, rb] = b.split('|');
			return ka.localeCompare(kb) || Number(ra) - Number(rb);
		})
		.map(([, e]) => e.place);
}
