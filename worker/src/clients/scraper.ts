/**
 * Typed client for hadoku-scrape `/api/v1/jobboards/*` endpoints.
 *
 * Auth: `X-User-Key: ${env.SCRAPER_USER_KEY}` — service-tier key bound from
 * vault JOBPLATFORM_SCRAPER_KEY. Bearer was deprecated 2026-05-05 (scraper
 * backend rejects Bearer; only X-User-Key is accepted post-PR1). Push key
 * via `python scripts/administration.py cloudflare-secrets jobplatform-api`.
 *
 * OpenAPI source of truth: https://scraper.hadoku.me/openapi.json
 */

import type { AppEnv } from '../types.js';

const DEFAULT_BASE_URL = 'https://scraper.hadoku.me';

/** One provider's answer for a probed slug. Only greenhouse exposes a name. */
interface ProviderHit {
	ats: string;
	company_name: string | null;
	n_jobs: number;
	sample_titles: string[];
}

export interface SlugProbeResult {
	slug: string;
	hits: ProviderHit[];
}

interface ProbeResponse {
	success: boolean;
	data?: { results: SlugProbeResult[] };
	error?: { message: string } | null;
}

/** The single best board matched to a typed company name (most open jobs). */
export interface CompanyMatch {
	query: string;
	matched: boolean;
	ats: string | null;
	slug: string | null;
	company_name: string | null;
	n_jobs: number;
	sample_titles: string[];
	domain: string | null;
}

interface MatchResponse {
	success: boolean;
	data?: { results: CompanyMatch[] };
	error?: { message: string } | null;
}

// Fields are declared and assigned explicitly rather than via TypeScript
// parameter properties: node's strip-only type stripping rejects those outright,
// and the integration tests import the whole worker through it.
export class ScraperClientError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(message: string, status: number, body: string) {
		super(message);
		this.name = 'ScraperClientError';
		this.status = status;
		this.body = body;
	}
}

function baseUrl(env: AppEnv): string {
	return env.SCRAPER_BASE_URL ?? DEFAULT_BASE_URL;
}

interface ScraperFetchInit {
	method: 'GET' | 'POST' | 'DELETE';
	body?: string;
}

async function scraperFetch(env: AppEnv, path: string, init: ScraperFetchInit): Promise<Response> {
	if (!env.SCRAPER_USER_KEY) {
		throw new ScraperClientError('SCRAPER_USER_KEY is not configured', 500, '');
	}
	const url = `${baseUrl(env)}${path}`;
	return fetch(url, {
		method: init.method,
		body: init.body,
		headers: {
			'Content-Type': 'application/json',
			'X-User-Key': env.SCRAPER_USER_KEY,
		},
	});
}

/**
 * Probe explicit slugs against each ATS. Read-only — reports the company name
 * (greenhouse only), open-job count, and sample titles per provider so the
 * operator can confirm the correct (ats, slug) before locking it in. Does NOT
 * register anything.
 */
export async function probeSlugs(
	env: AppEnv,
	slugs: string[],
	providers?: string[]
): Promise<SlugProbeResult[]> {
	const response = await scraperFetch(env, '/api/v1/jobboards/probe', {
		method: 'POST',
		body: JSON.stringify(providers ? { slugs, providers } : { slugs }),
	});
	if (!response.ok) {
		throw new ScraperClientError(
			`scraper /probe returned ${response.status}`,
			response.status,
			await response.text()
		);
	}
	const json: ProbeResponse = await response.json();
	if (!json.success || !json.data) {
		throw new ScraperClientError(
			`scraper /probe reported failure: ${json.error?.message ?? 'unknown'}`,
			500,
			JSON.stringify(json)
		);
	}
	return json.data.results;
}

/**
 * Match company names to the single best board each (most open jobs). Read-only.
 * Powers the name-driven prefetch: the user types "Scale AI" and gets
 * greenhouse:scaleai + display name + job count to confirm before locking.
 */
export async function matchCompanies(
	env: AppEnv,
	names: string[],
	providers?: string[]
): Promise<CompanyMatch[]> {
	const response = await scraperFetch(env, '/api/v1/jobboards/match', {
		method: 'POST',
		body: JSON.stringify(providers ? { names, providers } : { names }),
	});
	if (!response.ok) {
		throw new ScraperClientError(
			`scraper /match returned ${response.status}`,
			response.status,
			await response.text()
		);
	}
	const json: MatchResponse = await response.json();
	if (!json.success || !json.data) {
		throw new ScraperClientError(
			`scraper /match reported failure: ${json.error?.message ?? 'unknown'}`,
			500,
			JSON.stringify(json)
		);
	}
	return json.data.results;
}

/**
 * Trigger a scrape across all active registry targets. Fire-and-forget (202).
 *
 * Note: scraper has no per-target /search filter, so calling this after adding
 * one company runs the full active registry. Acceptable for a small registry;
 * worth revisiting if registry grows.
 */
export async function triggerSearch(env: AppEnv): Promise<void> {
	const response = await scraperFetch(env, '/api/v1/jobboards/search', {
		method: 'POST',
		body: JSON.stringify({}),
	});
	if (response.status !== 202 && !response.ok) {
		throw new ScraperClientError(
			`scraper /search returned ${response.status}`,
			response.status,
			await response.text()
		);
	}
}
