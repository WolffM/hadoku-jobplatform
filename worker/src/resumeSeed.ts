/**
 * What resume-api needs to build a person's own résumé, read off their
 * applicant profile.
 *
 * resume-api keeps résumé content per user (its blocks and contact profile).
 * A user who has never had any gets a 409 (`NO_RESUME_BLOCKS` /
 * `NO_CONTACT_PROFILE`) instead of the owner's résumé, and tailoring.ts seeds
 * them from here: the `master_resume_text` they saved when there is one, else
 * a résumé composed from the structured fields.
 */

type Profile = Record<string, unknown>;

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function records(v: unknown): Profile[] {
	return Array.isArray(v)
		? v.filter((x): x is Profile => typeof x === 'object' && x !== null && !Array.isArray(x))
		: [];
}

/** "03/2022", "2022" or "" from a month/year pair. */
function monthYear(month: unknown, year: unknown): string {
	const y = str(year);
	if (!y) return '';
	const m = str(month);
	return m ? `${m.padStart(2, '0')}/${y}` : y;
}

/** Languages as the profile may hold them: strings, or {language, level} objects. */
function languageLine(v: unknown): string {
	if (typeof v === 'string') return v.trim();
	if (!Array.isArray(v)) return '';
	return v
		.map((l) => {
			if (typeof l === 'string') return l.trim();
			if (typeof l !== 'object' || l === null) return '';
			const o = l as Profile;
			const name = str(o.language) || str(o.name);
			const level = str(o.level) || str(o.proficiency);
			return name && level ? `${name} (${level})` : name;
		})
		.filter(Boolean)
		.join(', ');
}

/**
 * The résumé text to import: `master_resume_text` when the person saved one,
 * otherwise markdown composed from name, contact, headline, summary, work
 * history, education and languages. Null when there is nothing beyond a name
 * and contact details, because a résumé of only a header is not worth sending.
 */
export function profileResumeText(profile: Profile): string | null {
	const master = str(profile.master_resume_text);
	if (master) return master;

	const sections: string[] = [];
	const summary = [str(profile.headline), str(profile.summary)].filter(Boolean).join('\n\n');
	if (summary) sections.push(`## Summary\n\n${summary}`);

	const jobs = records(profile.work_experience)
		.filter((w) => str(w.company))
		.map((w) => {
			const start = monthYear(w.start_month, w.start_year);
			const end = w.current === true ? 'present' : monthYear(w.end_month, w.end_year);
			const dates = [start, end].filter(Boolean).join(' - ');
			const title = str(w.title) || str(w.company);
			const heading = dates ? `${title} - ${dates}` : title;
			const lines = [`### ${heading}`, `**${str(w.company)}**`];
			const description = str(w.description) || str(w.summary);
			if (description) lines.push('', description);
			return lines.join('\n');
		});
	if (jobs.length) sections.push(`## Experience\n\n${jobs.join('\n\n')}`);

	const schools = records(profile.education)
		.filter((e) => str(e.school))
		.map((e) => {
			const what = [str(e.degree), str(e.discipline)].filter(Boolean).join(', ');
			const years = [str(e.start_year), str(e.end_year)].filter(Boolean).join(' - ');
			return `- ${[what, str(e.school), years].filter(Boolean).join(', ')}`;
		});
	if (schools.length) sections.push(`## Education\n\n${schools.join('\n')}`);

	const skills = Array.isArray(profile.skills)
		? profile.skills.map(str).filter(Boolean).join(', ')
		: str(profile.skills);
	if (skills) sections.push(`## Skills\n\n${skills}`);

	const languages = languageLine(profile.languages);
	if (languages) sections.push(`## Languages\n\n${languages}`);

	if (!sections.length) return null;
	const contact = [
		str(profile.email),
		str(profile.phone),
		str(profile.location),
		str(profile.linkedin),
	]
		.filter(Boolean)
		.join(' - ');
	const header = [`# ${str(profile.name)}`, contact].filter(Boolean).join('\n\n');
	return `${header}\n\n${sections.join('\n\n')}\n`;
}

/** resume-api's contact profile (its `ContactProfile`), from the applicant profile. */
export function profileContact(profile: Profile): Record<string, string> {
	return {
		name: str(profile.name),
		email: str(profile.email),
		phone: str(profile.phone),
		linkedin: str(profile.linkedin),
		github: str(profile.github),
		location: str(profile.location),
		work_auth: str(profile.work_authorization),
		relocation: str(profile.relocation),
		salary_line: str(profile.desired_salary),
	};
}
