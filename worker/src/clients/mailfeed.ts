/**
 * Client for contact-api's mail feed — ATS mail addressed to the owner.
 *
 * Auth: `X-User-Key: ${env.SCRAPER_USER_KEY}`, the service identity this worker
 * already holds. We carry NO mail credential: contact-api resolves the key to a
 * userId and looks that up in a grant table naming our sender domains.
 * Everything else in the mailbox is invisible to us, enforced in SQL rather
 * than filtered after the fetch. Service tier alone is not enough — every
 * worker key in the fleet has that and they all get 403.
 *
 * See docs/RESPONSE-application-mail-access.md for the contract.
 */

import type { AppEnv } from '../types.js';

const DEFAULT_BASE_URL = 'https://hadoku.me/contact/api/mailfeed';

/** One message. `body` is fetched but deliberately never persisted. */
export interface MailMessage {
	id: string;
	receivedAt: number;
	from: string;
	fromDomain: string;
	subject: string;
	body: string;
	source: 'live' | 'archive';
}

export interface MailPage {
	messages: MailMessage[];
	nextCursor: string | null;
}

export interface MailScope {
	label: string;
	senderDomains: string[];
}

interface Wrapped<T> {
	success: boolean;
	data?: T;
	error?: string;
	message?: string;
}

function baseUrl(env: AppEnv): string {
	return (env.MAILFEED_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

async function get<T>(env: AppEnv, path: string): Promise<T | { error: string }> {
	const key = env.SCRAPER_USER_KEY;
	if (!key) return { error: 'SCRAPER_USER_KEY is not bound — cannot read the mail feed' };
	let res: Response;
	try {
		res = await fetch(`${baseUrl(env)}${path}`, { headers: { 'X-User-Key': key } });
	} catch (err) {
		return { error: `mail feed unreachable: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!res.ok) {
		// 403 here means the grant does not cover us, which is a configuration
		// fact worth saying out loud rather than a transient failure to retry.
		return { error: `mail feed returned ${res.status}` };
	}
	// Annotation, not an `as` assertion: the repo-root eslint runs with --fix in
	// the pre-commit hook and strips assertions it judges unnecessary, which
	// leaves the value untyped and the rule then complains about its own edit.
	// src/clients/scraper.ts uses this same form for the same reason.
	const body: Wrapped<T> = await res.json();
	if (!body.success || !body.data) {
		return { error: body.message ?? body.error ?? 'mail feed returned an unsuccessful response' };
	}
	return body.data;
}

/**
 * The sender domains we are actually granted.
 *
 * Asserted on every run, and not as a formality. An empty page and a grant that
 * silently lost a domain look identical from `/messages`, and detecting silence
 * is this feature's entire job. This is also precisely how the `greenhouse.io`
 * error would have been caught before it shipped: the grant would have listed a
 * domain that has never delivered anything.
 */
export async function fetchScope(env: AppEnv): Promise<MailScope | { error: string }> {
	return get<MailScope>(env, '/scope');
}

/**
 * One page of mail, oldest first.
 *
 * Ascending `(created_at, id)` across the live table and the archive both, so
 * the FIRST call with no cursor is the backfill and the same loop tomorrow from
 * the stored cursor is the incremental poll. There is deliberately no separate
 * import path: a second path is a second implementation of the same matching
 * rules, and that drift is what this shape prevents.
 */
export async function fetchMessages(
	env: AppEnv,
	opts: { cursor?: string | null; limit?: number } = {}
): Promise<MailPage | { error: string }> {
	const params = new URLSearchParams();
	if (opts.cursor) params.set('cursor', opts.cursor);
	params.set('limit', String(opts.limit ?? 100));
	return get<MailPage>(env, `/messages?${params.toString()}`);
}

export function isFeedError<T>(value: T | { error: string }): value is { error: string } {
	return typeof value === 'object' && value !== null && 'error' in value;
}
