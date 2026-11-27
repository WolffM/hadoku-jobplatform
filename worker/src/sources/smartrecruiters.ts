/**
 * SmartRecruiters' public Posting API, used by large German and European
 * employers (Delivery Hero, Vattenfall, Ramboll, ...). No key:
 * `GET /v1/companies/<id>/postings` lists a board (100 a page, filterable by
 * country), and `GET /v1/companies/<id>/postings/<postingId>` carries the job
 * ad. Documented at https://developers.smartrecruiters.com/docs/posting-api.
 */
import type { IngestJob } from '../ingestWrite.js';
import { escapeHtml } from './html.js';
import { getJson } from './http.js';
import type { Listing, SourceContext, SourceTask } from './types.js';

export const SOURCE_SITE = 'smartrecruiters.com';
const API_BASE = 'https://api.smartrecruiters.com';

const PAGE_SIZE = 100;
/** Pages read per board a run: up to 500 postings. */
const MAX_PAGES = 5;

type SmartRecruitersTask = Extract<SourceTask, { source: 'smartrecruiters' }>;

export interface SrPosting {
	id: string;
	name?: string;
	releasedDate?: string;
	company?: { identifier?: string; name?: string };
	location?: {
		city?: string;
		region?: string;
		country?: string;
		remote?: boolean;
		hybrid?: boolean;
		fullLocation?: string;
	};
	department?: { label?: string };
	typeOfEmployment?: { id?: string; label?: string };
	experienceLevel?: { label?: string };
	[key: string]: unknown;
}

interface SrPage {
	totalFound?: number;
	content?: SrPosting[];
}

export interface SrDetail {
	postingUrl?: string;
	applyUrl?: string;
	jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
	[key: string]: unknown;
}

function apiBase(ctx: SourceContext): string {
	return ctx.baseOverride ? `${ctx.baseOverride}/smartrecruiters` : API_BASE;
}

export function listUrl(task: SmartRecruitersTask, offset: number, ctx: SourceContext): string {
	const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
	if (task.country) q.set('country', task.country);
	return `${apiBase(ctx)}/v1/companies/${encodeURIComponent(task.company)}/postings?${q.toString()}`;
}

export function detailUrl(company: string, id: string, ctx: SourceContext): string {
	return `${apiBase(ctx)}/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`;
}

/** The public posting page. The short form redirects to the slugged one. */
export function postingUrl(company: string, id: string): string {
	return `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
}

/**
 * "Berlin, , Germany" -> "Berlin, Germany": the API leaves an empty slot when
 * a posting has no region.
 */
export function locationText(loc: SrPosting['location']): string {
	if (!loc) return '';
	const full = (loc.fullLocation ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.join(', ');
	return full || [loc.city, loc.country?.toUpperCase()].filter(Boolean).join(', ');
}

function workplaceType(loc: SrPosting['location']): string {
	if (loc?.remote) return 'remote';
	if (loc?.hybrid) return 'hybrid';
	// SmartRecruiters states both flags on every posting, so neither set
	// means the employer said on site.
	return loc ? 'onsite' : 'unknown';
}

function jobType(p: SrPosting): string {
	const label = (p.typeOfEmployment?.label ?? p.typeOfEmployment?.id ?? '').toLowerCase();
	if (label.includes('full')) return 'full_time';
	if (label.includes('part')) return 'part_time';
	if (label.includes('contract') || label.includes('freelance')) return 'contract';
	return 'unknown';
}

export function normalizePosting(p: SrPosting, task: SmartRecruitersTask): IngestJob {
	const company = p.company?.identifier ?? task.company;
	const url = postingUrl(company, p.id);
	return {
		id: `smartrecruiters_${p.id}`,
		url,
		source_site: SOURCE_SITE,
		title: (p.name ?? '').trim(),
		company: p.company?.name ?? task.company,
		location: locationText(p.location),
		job_type: jobType(p),
		workplace_type: workplaceType(p.location),
		salary: null,
		description: '',
		posted_date: p.releasedDate ?? null,
		application_url: url,
		department: p.department?.label ?? null,
		scraper_used: 'smartrecruiters',
		raw: {
			company_identifier: company,
			experience_level: p.experienceLevel?.label ?? null,
			type_of_employment: p.typeOfEmployment?.label ?? null,
		},
	};
}

/** The job ad's sections, in the order the posting page shows them. */
const SECTION_ORDER = [
	'companyDescription',
	'jobDescription',
	'qualifications',
	'additionalInformation',
];

export function withDetail(job: IngestJob, detail: SrDetail): IngestJob {
	const sections = detail.jobAd?.sections ?? {};
	const html = SECTION_ORDER.map((key) => sections[key])
		.filter((s): s is { title?: string; text?: string } => Boolean(s?.text))
		.map((s) => (s.title ? `<h3>${escapeHtml(s.title)}</h3>${s.text}` : s.text!))
		.join('\n');
	return {
		...job,
		description: html || job.description,
		application_url: detail.applyUrl ?? job.application_url,
	};
}

/** One board, paged; descriptions come from a detail call per new posting. */
export async function list(task: SmartRecruitersTask, ctx: SourceContext): Promise<Listing[]> {
	const out: Listing[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const body = await getJson<SrPage>(ctx.http, listUrl(task, page * PAGE_SIZE, ctx));
		const rows = body.content ?? [];
		for (const p of rows) {
			if (!p.id || !p.name) continue;
			const company = p.company?.identifier ?? task.company;
			out.push({ job: normalizePosting(p, task), detailUrl: detailUrl(company, p.id, ctx) });
		}
		if (rows.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= (body.totalFound ?? 0)) break;
	}
	return out;
}

export async function fetchDetail(
	job: IngestJob,
	url: string,
	ctx: SourceContext
): Promise<IngestJob> {
	return withDetail(job, await getJson<SrDetail>(ctx.http, url));
}
