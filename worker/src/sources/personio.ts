/**
 * Personio, the HR suite most German startups and Mittelstand companies hire
 * through. Every company with a public career page also publishes the whole
 * board as XML at `https://<slug>.jobs.personio.de/xml`: no key, no paging,
 * descriptions included, so one request per board.
 *
 * Workers have no DOMParser, and the feed is a flat, machine-written format
 * (`<position>` elements of scalar fields, descriptions in CDATA), so it is
 * read with a small tag reader rather than a dependency.
 */
import type { IngestJob } from '../ingestWrite.js';
import { escapeHtml } from './html.js';
import { getText } from './http.js';
import { SourceFetchError, type Listing, type SourceContext, type SourceTask } from './types.js';

export const SOURCE_SITE = 'jobs.personio.de';

type PersonioTask = Extract<SourceTask, { source: 'personio' }>;

export function feedUrl(slug: string, ctx: SourceContext): string {
	const s = encodeURIComponent(slug);
	return ctx.baseOverride
		? `${ctx.baseOverride}/personio/${s}/xml?language=en`
		: `https://${s}.jobs.personio.de/xml?language=en`;
}

export function postingUrl(slug: string, id: string): string {
	return `https://${encodeURIComponent(slug)}.jobs.personio.de/job/${encodeURIComponent(id)}`;
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/** Text content of an XML node: CDATA kept verbatim, entities decoded elsewhere. */
function decode(raw: string): string {
	const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
	if (cdata) return cdata[1].trim();
	return raw
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
			if (e.startsWith('#')) {
				const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
				return Number.isFinite(code) ? String.fromCodePoint(code) : m;
			}
			return ENTITIES[e.toLowerCase()] ?? m;
		})
		.trim();
}

/** Every `<tag>...</tag>` directly in `xml`, in order (tags here never self-nest). */
function all(xml: string, tag: string): string[] {
	const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
	return [...xml.matchAll(re)].map((m) => m[1]);
}

function one(xml: string, tag: string): string | null {
	const found = all(xml, tag);
	return found.length ? decode(found[0]) : null;
}

/**
 * Standing "send us your CV" entries. They are on nearly every board, and
 * they are not a job: no role, no team, nothing to score.
 */
const NOT_A_POSTING =
	/initiativbewerbung|unsolicited application|open application|speculative application|talent ?pool/i;

export interface PersonioPosition {
	id: string;
	name: string;
	offices: string[];
	department: string | null;
	subcompany: string | null;
	employmentType: string | null;
	schedule: string | null;
	seniority: string | null;
	createdAt: string | null;
	/** `<h3>section</h3>` + the section's HTML, per job description section. */
	descriptionHtml: string;
}

/** Read the feed's `<position>` elements. Throws when the body is not a Personio feed. */
export function parseFeed(xml: string): PersonioPosition[] {
	if (!xml.includes('<workzag-jobs')) {
		throw new SourceFetchError('jobs.personio.de answered something that is not a job feed', null);
	}
	return all(xml, 'position').map((block) => {
		// Description sections carry their own <name>; read them first and cut
		// them out, so the position's <name> is the one left.
		const descBlock = all(block, 'jobDescriptions')[0] ?? '';
		const rest = block.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, '');
		const sections = all(descBlock, 'jobDescription').map((d) => {
			const title = one(d, 'name');
			const value = one(d, 'value') ?? '';
			return title ? `<h3>${escapeHtml(title)}</h3>${value}` : value;
		});
		const additional = all(rest, 'additionalOffices')[0] ?? '';
		const main = rest.replace(/<additionalOffices>[\s\S]*?<\/additionalOffices>/, '');
		const offices = [...all(main, 'office'), ...all(additional, 'office')]
			.map(decode)
			.filter((o, i, arr) => o && arr.indexOf(o) === i);
		return {
			id: one(rest, 'id') ?? '',
			name: one(rest, 'name') ?? '',
			offices,
			department: one(rest, 'department'),
			subcompany: one(rest, 'subcompany'),
			employmentType: one(rest, 'employmentType'),
			schedule: one(rest, 'schedule'),
			seniority: one(rest, 'seniority'),
			createdAt: one(rest, 'createdAt'),
			descriptionHtml: sections.filter(Boolean).join('\n'),
		};
	});
}

function workplaceType(offices: string[]): string {
	const remote = offices.filter((o) => /\bremote\b/i.test(o));
	if (remote.length === 0) return 'unknown';
	return remote.length === offices.length ? 'remote' : 'hybrid';
}

function jobType(p: PersonioPosition): string {
	if (p.employmentType === 'freelance') return 'contract';
	if (p.schedule === 'full-time') return 'full_time';
	if (p.schedule === 'part-time') return 'part_time';
	return 'unknown';
}

export function normalizePosition(p: PersonioPosition, task: PersonioTask): IngestJob {
	const url = postingUrl(task.slug, p.id);
	return {
		id: `personio_${p.id}`,
		url,
		source_site: SOURCE_SITE,
		title: p.name,
		company: task.company || p.subcompany || task.slug,
		location: p.offices.join(' | '),
		job_type: jobType(p),
		workplace_type: workplaceType(p.offices),
		salary: null,
		description: p.descriptionHtml,
		posted_date: p.createdAt,
		application_url: url,
		department: p.department,
		scraper_used: 'personio',
		raw: {
			subcompany: p.subcompany,
			employment_type: p.employmentType,
			schedule: p.schedule,
			seniority: p.seniority,
		},
	};
}

/** One board, whole. Descriptions are inline, so no listing needs a detail call. */
export async function list(task: PersonioTask, ctx: SourceContext): Promise<Listing[]> {
	const xml = await getText(ctx.http, feedUrl(task.slug, ctx), { Accept: 'application/xml' });
	return parseFeed(xml)
		.filter((p) => p.id && p.name && !NOT_A_POSTING.test(p.name))
		.map((p) => ({ job: normalizePosition(p, task), detailUrl: null }));
}
