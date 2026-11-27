/**
 * resume-api, as this worker calls it: through the edge, as its own service
 * identity. Shared by the tailoring routes and the applicant-profile save,
 * which re-seeds a person's résumé at resume-api when their résumé text changes.
 */
import { EDGE_BASE } from '@wolffm/worker-utils/edge-routes';
import type { AppEnv } from '../types.js';
import { profileContact, profileResumeText } from '../resumeSeed.js';
import { logger } from '../logger.js';

/**
 * resume-api, reached the way any service caller reaches it: through the
 * edge, over the EDGE binding, as this worker's own service identity. It
 * used to be called over its own binding with `X-Edge-Auth` and
 * `X-Hadoku-Tier` stamped from EDGE_AUTH_SECRET. Since 2026-11-02 each backend
 * holds its own seal, so this worker's opens this worker alone, and a tier is
 * the edge's to stamp, never a caller's.
 */
export function resumeViaEdge(
	env: AppEnv,
	path: string,
	init: { method: 'GET' | 'POST' | 'PUT'; headers?: Record<string, string>; body?: string }
): Promise<Response> {
	if (!env.EDGE) throw new Error('EDGE service binding not configured');
	const key = env.HADOKU_SERVICE_KEY?.trim();
	if (!key) throw new Error('HADOKU_SERVICE_KEY not configured');
	const headers = new Headers(init.headers);
	headers.set('X-User-Key', key);
	return env.EDGE.fetch(`${EDGE_BASE}${path}`, { ...init, headers });
}

export async function callResumeBinding(
	env: AppEnv,
	path: string,
	payload: Record<string, unknown>,
	method: 'POST' | 'PUT' = 'POST'
): Promise<Response> {
	return resumeViaEdge(env, path, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
}

/**
 * Whether a profile save has to replace the person's résumé at resume-api: it
 * has something to build from, and either that résumé text (the saved
 * `master_resume_text`, or the one composed from the structured fields) or
 * the contact details changed. Contact goes through the same import, so the
 * details parsed from the résumé header and the profile's merge the same way
 * as on the first seed.
 *
 * A profile that no longer has anything to build from leaves resume-api
 * alone: the person keeps the résumé they had there.
 */
export function resumeNeedsReseed(
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown>
): boolean {
	const text = profileResumeText(after);
	if (!text) return false;
	if (!before) return true;
	if (text !== profileResumeText(before)) return true;
	return JSON.stringify(profileContact(after)) !== JSON.stringify(profileContact(before));
}

/** The JSON `code` of a resume-api error body, if it has one. */
function errorCode(detail: string): string | null {
	try {
		const body: unknown = JSON.parse(detail);
		const code =
			typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
		return typeof code === 'string' ? code : null;
	} catch {
		return null;
	}
}

/**
 * Replace a person's résumé content at resume-api with what their applicant
 * profile now says. Called after a profile save that changed the résumé text
 * or contact details (resumeNeedsReseed), so tailoring stops using the old
 * ones. A profile with nothing to build from is left alone, and so is the
 * site owner's (resume-api answers OWNER_SET). A 404 means resume-api does not
 * have per-user résumés yet (this worker deployed first): logged, not
 * reported. Throws on any other upstream failure, for runAfterResponse to
 * report.
 */
export async function reseedResume(
	env: AppEnv,
	userId: string,
	profile: Record<string, unknown>
): Promise<void> {
	const text = profileResumeText(profile);
	if (!text) return;
	const res = await callResumeBinding(env, '/resume/api/blocks/import', {
		on_behalf_of_user_id: userId,
		resume_text: text,
		contact: profileContact(profile),
		replace: true,
	});
	if (res.ok) return;
	const detail = await res.text();
	// The site owner's résumé is curated in resume-api's own builder, and
	// resume-api refuses to overwrite it from here. That is not a failure.
	if (res.status === 403 && errorCode(detail) === 'OWNER_SET') return;
	if (res.status === 404) {
		logger.warn('resume-api has no per-user résumé import yet; reseed skipped', {
			user_id: userId,
		});
		return;
	}
	throw new Error(`resume-api reseed ${res.status}: ${detail.slice(0, 300)}`);
}
