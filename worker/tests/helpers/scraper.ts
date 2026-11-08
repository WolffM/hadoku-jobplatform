import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the stand-in answers for one URL: a posting, or an error as the scraper words it. */
export type ExtractAnswer =
	| { job: Record<string, unknown>; ats?: string | null; board_slug?: string | null }
	| { status: number; detail: string };

/**
 * A loopback hadoku-scrape answering POST /api/v1/jobboards/extract from a
 * table keyed by URL. Records every request body, so a test can assert what
 * the worker sent (the greenhouse_slug hint) — or that it never called at all.
 */
export async function startScraper(answers: Record<string, ExtractAnswer>): Promise<{
	url: string;
	calls: { url: string; greenhouse_slug?: string; key: string }[];
	stop(): Promise<void>;
}> {
	const calls: { url: string; greenhouse_slug?: string; key: string }[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		req.on('end', () => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			if (req.url !== '/api/v1/jobboards/extract') return send(404, { detail: 'Not Found' });
			const body = JSON.parse(raw) as { url: string; greenhouse_slug?: string };
			calls.push({ ...body, key: String(req.headers['x-user-key'] ?? '') });
			const answer = answers[body.url];
			if (!answer) return send(422, { detail: 'no posting on that page' });
			if ('status' in answer) return send(answer.status, { detail: answer.detail });
			return send(200, {
				success: true,
				data: { job: answer.job, ats: answer.ats ?? null, board_slug: answer.board_slug ?? null },
				error: null,
			});
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		stop: () => new Promise<void>((r) => server.close(() => r())),
	};
}
