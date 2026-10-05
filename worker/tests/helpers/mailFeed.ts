import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One mail-feed message, in contact-api's shape. */
export interface FeedMessage {
	id: string;
	receivedAt: number;
	from: string;
	fromDomain: string;
	subject: string;
	body: string;
	source: 'live' | 'archive';
}

/** A loopback contact-api. Records the key it was presented. */
export async function startFeed(opts: {
	messages: FeedMessage[];
	domains?: string[];
	scopeStatus?: number;
}): Promise<{ url: string; keys: string[]; stop(): Promise<void> }> {
	const keys: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		keys.push(String(req.headers['x-user-key'] ?? ''));
		const url = new URL(req.url ?? '/', 'http://localhost');
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (url.pathname.endsWith('/scope')) {
			if (opts.scopeStatus && opts.scopeStatus !== 200) return send(opts.scopeStatus, {});
			return send(200, {
				success: true,
				data: {
					label: 'jobplatform',
					senderDomains: opts.domains ?? ['greenhouse-mail.io', 'ashbyhq.com'],
				},
			});
		}
		if (url.pathname.endsWith('/messages')) {
			// One page; the cursor loop is exercised by nextCursor being null.
			return send(200, {
				success: true,
				data: { messages: opts.messages, nextCursor: null },
			});
		}
		return send(404, { success: false, error: 'Not found' });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		keys,
		stop: () => new Promise<void>((r) => server.close(() => r())),
	};
}
