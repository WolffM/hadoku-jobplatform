/**
 * The page a person fills to apply for this job — what the dashboard's
 * "Open form" links to, and where the Fill extension runs.
 *
 * Built from the board and slug the scraper recorded rather than the posting
 * URL: a Greenhouse posting is often published on the employer's own careers
 * page (samsara.com/…?gh_jid=), which is a wrapper the extension cannot see
 * into reliably. The embed form is the same application, served by Greenhouse.
 * Mirrors the runner's GreenhouseFiller.rewrite_url and its Ashby/Lever URLs.
 */
export function formUrl(job: {
	id: string;
	ats: string | null;
	slug: string | null;
	url: string;
}): string {
	const own = job.id.slice(job.id.indexOf('_') + 1);
	if (job.slug && job.id.startsWith('greenhouse_') && /^\d+$/.test(own)) {
		return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(job.slug)}&token=${own}`;
	}
	if (job.slug && job.id.startsWith('ashby_')) {
		return `https://jobs.ashbyhq.com/${encodeURIComponent(job.slug)}/${own}/application`;
	}
	if (job.slug && job.id.startsWith('lever_')) {
		return `https://jobs.lever.co/${encodeURIComponent(job.slug)}/${own}/apply`;
	}
	return job.url;
}
