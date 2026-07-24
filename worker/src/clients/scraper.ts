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

export interface TargetView {
	id: number;
	ats: string;
	slug: string;
	added_at: string;
	last_scraped_at: string | null;
	last_job_count: number | null;
	consecutive_failures: number;
	disabled_at: string | null;
	disabled_reason: string | null;
	is_active: boolean;
	/** Present when the target was added by display name via /resolve. */
	display_name?: string;
}

export interface AddTargetsResponse {
	success: boolean;
	data?: {
		added: TargetView[];
		skipped: TargetView[];
		added_count: number;
	};
	error?: { message: string } | null;
}

/** One provider's answer for a probed slug. Only greenhouse exposes a name. */
export interface ProviderHit {
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

export class ScraperClientError extends Error {
	constructor(
		message: string,
		public status: number,
		public body: string
	) {
		super(message);
		this.name = 'ScraperClientError';
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
 * Add targets by display name. Scraper resolves each name to one or more
 * (ats, slug) pairs and registers each. Returns one TargetView per added
 * target — a single name can produce multiple entries.
 */
export async function addTargetsByName(
	env: AppEnv,
	displayNames: string[],
	options: { useLlm?: boolean } = {}
): Promise<{ added: TargetView[]; skipped: TargetView[] }> {
	const response = await scraperFetch(env, '/api/v1/jobboards/targets', {
		method: 'POST',
		body: JSON.stringify({
			companies: displayNames,
			use_llm: options.useLlm ?? true,
		}),
	});
	if (!response.ok) {
		throw new ScraperClientError(
			`scraper /targets returned ${response.status}`,
			response.status,
			await response.text()
		);
	}
	const json: AddTargetsResponse = await response.json();
	if (!json.success || !json.data) {
		throw new ScraperClientError(
			`scraper /targets reported failure: ${json.error?.message ?? 'unknown'}`,
			500,
			JSON.stringify(json)
		);
	}
	return { added: json.data.added, skipped: json.data.skipped };
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
 * Register a single target by explicit (ats, slug) — the "lock in" half of the
 * verify-and-lock flow, bypassing name resolution entirely. Returns the
 * registered TargetView.
 */
export async function addTargetBySlug(env: AppEnv, ats: string, slug: string): Promise<TargetView> {
	const response = await scraperFetch(env, '/api/v1/jobboards/targets', {
		method: 'POST',
		body: JSON.stringify({ targets: [{ ats, slug }] }),
	});
	if (!response.ok) {
		throw new ScraperClientError(
			`scraper /targets returned ${response.status}`,
			response.status,
			await response.text()
		);
	}
	const json: AddTargetsResponse = await response.json();
	if (!json.success || !json.data || json.data.added.length === 0) {
		throw new ScraperClientError(
			`scraper /targets did not register ${ats}:${slug}: ${json.error?.message ?? 'no target added'}`,
			500,
			JSON.stringify(json)
		);
	}
	return json.data.added[0];
}

/**
 * Hard-delete a target by scraper id.
 *
 * Scraper returns 404 on missing target. We swallow that — from our caller's
 * perspective "delete a thing that doesn't exist" is success (idempotent).
 */
export async function deleteTarget(env: AppEnv, targetId: number): Promise<void> {
	const response = await scraperFetch(env, `/api/v1/jobboards/targets/${targetId}`, {
		method: 'DELETE',
	});
	if (response.status === 404) return;
	if (!response.ok) {
		throw new ScraperClientError(
			`scraper DELETE /targets/${targetId} returned ${response.status}`,
			response.status,
			await response.text()
		);
	}
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
