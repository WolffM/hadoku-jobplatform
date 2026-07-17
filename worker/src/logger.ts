import { createWorkerLogger } from '@wolffm/logger/worker';

/**
 * Shared structured logger for the jobplatform worker.
 *
 * Sinks to `console.*` (which Cloudflare Workers Logs captures) via the
 * ecosystem worker logger, so there are no raw `console.*` call sites and log
 * entries are attributed to the `jobplatform-api` service. Mirrors resume-api's
 * setup.
 */
export const logger = createWorkerLogger({ service: 'jobplatform-api' });
