import { SourceFetchError, type HttpFetch } from './types.js';

/** Identifies the platform to the sources' operators, with a page to read about it. */
export const USER_AGENT = 'hadoku-jobplatform/1.0 (+https://hadoku.me/jobplatform/)';

/** No single source response may hold a pull up longer than this. */
const TIMEOUT_MS = 15_000;

/** GET a URL and return its body as text; any non-2xx is a SourceFetchError. */
export async function getText(
	http: HttpFetch,
	url: string,
	headers: Record<string, string> = {}
): Promise<string> {
	let res: Response;
	try {
		res = await http(url, {
			headers: { 'User-Agent': USER_AGENT, ...headers },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new SourceFetchError(`${new URL(url).host} unreachable: ${String(err)}`, null);
	}
	if (!res.ok) {
		throw new SourceFetchError(`${new URL(url).host} answered ${res.status}`, res.status);
	}
	return res.text();
}

/** GET a URL and parse it as JSON. */
export async function getJson<T>(
	http: HttpFetch,
	url: string,
	headers: Record<string, string> = {}
): Promise<T> {
	const text = await getText(http, url, { Accept: 'application/json', ...headers });
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new SourceFetchError(`${new URL(url).host} answered something that is not JSON`, null);
	}
}

/**
 * Run `fn` over `items` with at most `limit` requests in flight. The sources
 * are free public services; this is the politeness bound on top of the
 * per-call caps in run.ts. Results keep the input order; a rejected item
 * yields its error instead of failing the rest.
 */
export async function pooled<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<(R | Error)[]> {
	const out = new Array<R | Error>(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			try {
				out[i] = await fn(items[i]);
			} catch (err) {
				out[i] = err instanceof Error ? err : new Error(String(err));
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
