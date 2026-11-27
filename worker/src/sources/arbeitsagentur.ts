/**
 * Bundesagentur fuer Arbeit, Jobsuche API: a keyword + place search over the
 * federal job exchange, which holds most German job postings, the PM,
 * operations and Mittelstand roles no startup ATS carries included.
 *
 * Documented at https://jobsuche.api.bund.dev (bundesAPI/jobsuche-api). No
 * account: the API takes the public client id `jobboerse-jobsuche` in an
 * `X-API-Key` header. Search is `GET /pc/v6/jobs`, one posting's text is
 * `GET /pc/v4/jobdetails/<base64(referenznummer)>`; the search answers carry
 * no description, so run.ts fetches the detail for new postings only.
 */
import type { IngestJob } from '../ingestWrite.js';
import { getJson } from './http.js';
import type { Listing, SourceContext, SourceTask } from './types.js';

export const SOURCE_SITE = 'arbeitsagentur.de';
const API_BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service';
const HEADERS = { 'X-API-Key': 'jobboerse-jobsuche' };

/** Results per search page; the API's maximum. */
const PAGE_SIZE = 100;
/** Pages read per search, so one keyword is at most this many postings a run. */
const MAX_PAGES = 2;
/**
 * Only postings first published within this many days. The corpus culls at
 * 60 days, and a daily pull sees anything newer on the day it appears.
 */
const PUBLISHED_WITHIN_DAYS = 30;

type ArbeitsagenturTask = Extract<SourceTask, { source: 'arbeitsagentur' }>;

interface Location {
	adresse?: { ort?: string; plz?: string; region?: string; land?: string };
}

/** One entry of `ergebnisliste` (fields this adapter reads). */
export interface JobsucheListing {
	referenznummer: string;
	stellenangebotsTitel?: string;
	firma?: string;
	stellenlokationen?: Location[];
	arbeitszeitVollzeit?: boolean;
	arbeitszeitTeilzeitVormittag?: boolean;
	arbeitszeitTeilzeitNachmittag?: boolean;
	arbeitszeitTeilzeitAbend?: boolean;
	arbeitszeitTeilzeitFlexibel?: boolean;
	homeofficemoeglich?: boolean;
	verguetungsangabe?: string;
	gehaltsspanneVon?: number;
	gehaltsspanneBis?: number;
	datumErsteVeroeffentlichung?: string;
	hauptberuf?: string;
	externeURL?: string;
	[key: string]: unknown;
}

interface JobsucheSearch {
	ergebnisliste?: JobsucheListing[];
	maxErgebnisse?: number;
}

export interface JobsucheDetail {
	stellenangebotsBeschreibung?: string;
	[key: string]: unknown;
}

function apiBase(ctx: SourceContext): string {
	return ctx.baseOverride ? `${ctx.baseOverride}/arbeitsagentur` : API_BASE;
}

export function searchUrl(task: ArbeitsagenturTask, page: number, ctx: SourceContext): string {
	const q = new URLSearchParams({
		was: task.keyword,
		wo: task.where,
		umkreis: String(task.radius_km),
		// 1 = employment. Leaves out self-employment, apprenticeships, internships.
		angebotsart: '1',
		// Leave out private placement agencies and temp-staffing firms: the
		// same role reposted by a dozen intermediaries otherwise outnumbers the
		// employers' own postings.
		pav: 'false',
		zeitarbeit: 'false',
		veroeffentlichtseit: String(PUBLISHED_WITHIN_DAYS),
		size: String(PAGE_SIZE),
		page: String(page),
	});
	return `${apiBase(ctx)}/pc/v6/jobs?${q.toString()}`;
}

export function detailUrl(referenznummer: string, ctx: SourceContext): string {
	return `${apiBase(ctx)}/pc/v4/jobdetails/${btoa(referenznummer)}`;
}

/** "DEUTSCHLAND" -> "Deutschland". */
function titleCase(s: string): string {
	return s
		.toLowerCase()
		.split(/(\s|-)/)
		.map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w))
		.join('');
}

/**
 * The posting's places in the API's own words, "Berlin, Deutschland", joined
 * with " | " when it names several. geo.ts reads both the city and the
 * country word, so `near=berlin-de` finds these postings.
 */
export function locationText(locations: Location[] | undefined): string {
	const parts: string[] = [];
	for (const loc of locations ?? []) {
		const a = loc.adresse ?? {};
		const place = a.ort ?? (a.region ? titleCase(a.region) : null);
		if (!place) continue;
		const text = a.land ? `${place}, ${titleCase(a.land)}` : place;
		if (!parts.includes(text)) parts.push(text);
	}
	return parts.join(' | ');
}

function jobType(j: JobsucheListing): string {
	if (j.arbeitszeitVollzeit) return 'full_time';
	if (
		j.arbeitszeitTeilzeitVormittag ||
		j.arbeitszeitTeilzeitNachmittag ||
		j.arbeitszeitTeilzeitAbend ||
		j.arbeitszeitTeilzeitFlexibel
	) {
		return 'part_time';
	}
	return 'unknown';
}

/** The public posting page; every Jobsuche posting has one. */
export function postingUrl(referenznummer: string): string {
	return `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(referenznummer)}`;
}

/** One search result as an IngestJob, without its description. */
export function normalizeListing(j: JobsucheListing): IngestJob {
	const ref = j.referenznummer;
	// Only an annual range is comparable with the rest of the corpus; an hourly
	// or monthly figure stays in `raw` rather than posing as a salary.
	const annual =
		j.verguetungsangabe === 'JAHRESGEHALT' &&
		(typeof j.gehaltsspanneVon === 'number' || typeof j.gehaltsspanneBis === 'number');
	const url = postingUrl(ref);
	return {
		id: `arbeitsagentur_${ref}`,
		url,
		source_site: SOURCE_SITE,
		title: (j.stellenangebotsTitel ?? '').trim(),
		company: (j.firma ?? '').trim() || 'unknown',
		location: locationText(j.stellenlokationen),
		job_type: jobType(j),
		// The API says only whether home office is possible at all; a posting
		// that allows it is still tied to its place, so hybrid is the honest read.
		workplace_type: j.homeofficemoeglich ? 'hybrid' : 'unknown',
		salary: annual
			? {
					min: j.gehaltsspanneVon ?? null,
					max: j.gehaltsspanneBis ?? null,
					currency: 'EUR',
					period: 'year',
					text: null,
				}
			: null,
		description: '',
		posted_date: j.datumErsteVeroeffentlichung
			? `${j.datumErsteVeroeffentlichung}T00:00:00Z`
			: null,
		// Employers that post on their own site link it; otherwise the
		// application runs through the posting page itself.
		application_url: j.externeURL || url,
		department: null,
		scraper_used: 'arbeitsagentur',
		raw: j,
	};
}

/** Fill a listing's description from its detail answer. */
export function withDetail(job: IngestJob, detail: JobsucheDetail): IngestJob {
	const text = (detail.stellenangebotsBeschreibung ?? '').trim();
	return text ? { ...job, description: text } : job;
}

/** Run one keyword search: up to MAX_PAGES pages of results. */
export async function list(task: ArbeitsagenturTask, ctx: SourceContext): Promise<Listing[]> {
	const out: Listing[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = await getJson<JobsucheSearch>(ctx.http, searchUrl(task, page, ctx), HEADERS);
		const rows = body.ergebnisliste ?? [];
		for (const row of rows) {
			if (!row.referenznummer || !row.stellenangebotsTitel) continue;
			out.push({ job: normalizeListing(row), detailUrl: detailUrl(row.referenznummer, ctx) });
		}
		const total = body.maxErgebnisse ?? 0;
		if (rows.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
	}
	return out;
}

export async function fetchDetail(
	job: IngestJob,
	url: string,
	ctx: SourceContext
): Promise<IngestJob> {
	return withDetail(job, await getJson<JobsucheDetail>(ctx.http, url, HEADERS));
}
