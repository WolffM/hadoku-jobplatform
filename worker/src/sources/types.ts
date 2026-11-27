/**
 * Job sources the worker pulls itself, as opposed to the boards the scraper
 * posts to POST /ingest.
 *
 * Each source is a public, documented, unauthenticated feed: the Bundesagentur
 * fuer Arbeit's Jobsuche API (keyword + place search over Germany's largest job
 * database), Personio's per-company XML feed and SmartRecruiters' per-company
 * postings API (two ATSes most German employers that are not on Greenhouse,
 * Lever or Ashby use). Every adapter turns its feed into the same IngestJob a
 * scraper batch carries, and run.ts writes them through writeJobBatch, so a
 * pulled posting is deduped, classified, placed and ranked exactly like a
 * scraped one.
 */
import type { IngestJob } from '../ingestWrite.js';

/** `fetch`, injectable so tests can count and inspect the calls. */
export type HttpFetch = (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/** One unit of work: a single search, or a single company board. */
export type SourceTask =
	| {
			source: 'arbeitsagentur';
			/** A profile keyword, searched as the Jobsuche `was` (job title free text). */
			keyword: string;
			/** The Jobsuche `wo`: a German place name it resolves itself. */
			where: string;
			/** The Jobsuche `umkreis`, in kilometres around `where`. */
			radius_km: number;
	  }
	| {
			source: 'personio';
			/** The `<slug>` of `<slug>.jobs.personio.de`. */
			slug: string;
			/** Employer name to show; Personio's feed carries only legal entity names. */
			company: string;
	  }
	| {
			source: 'smartrecruiters';
			/** The company identifier in `api.smartrecruiters.com/v1/companies/<id>`. */
			company: string;
			/** ISO country filter (`de`), or null for the whole board. */
			country: string | null;
	  };

export type SourceName = SourceTask['source'];

/**
 * A posting as a listing returned it. `detailUrl` is set when the listing
 * carries no description and one more request fetches it; run.ts makes that
 * request only for postings the corpus does not hold yet.
 */
export interface Listing {
	job: IngestJob;
	detailUrl: string | null;
}

export interface SourceContext {
	http: HttpFetch;
	/**
	 * Test-only: route every source to `<base>/<source>/...` on one loopback
	 * server instead of the real hosts. Unset in production.
	 */
	baseOverride?: string;
}

/** A source answered with an error or with something that is not its format. */
export class SourceFetchError extends Error {
	status: number | null;
	constructor(message: string, status: number | null) {
		super(message);
		this.name = 'SourceFetchError';
		this.status = status;
	}
}
