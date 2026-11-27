import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileContact, profileResumeText } from '../src/resumeSeed.ts';

describe('profileResumeText', () => {
	it('prefers the saved master résumé text, verbatim', () => {
		assert.equal(
			profileResumeText({
				name: 'A',
				email: 'a@example.org',
				master_resume_text: '  # A\n\nText  ',
			}),
			'# A\n\nText'
		);
	});

	it('composes markdown from structured fields', () => {
		const text = profileResumeText({
			name: 'Kim Example',
			email: 'kim@example.org',
			phone: '+1 555 0100',
			location: 'Springfield',
			headline: 'Operations lead',
			summary: 'Runs things.',
			work_experience: [
				{ company: 'Acme', title: 'Ops Lead', start_year: 2021, end_month: '6', end_year: '2024' },
				{ company: '' },
				'junk',
			],
			education: [{ school: 'State U', degree: 'BSc', start_year: 2015, end_year: 2019 }],
			skills: ['Excel', 'SQL'],
			languages: [{ language: 'German', level: 'B1' }, 'English'],
		});
		assert.equal(
			text,
			[
				'# Kim Example',
				'',
				'kim@example.org - +1 555 0100 - Springfield',
				'',
				'## Summary',
				'',
				'Operations lead',
				'',
				'Runs things.',
				'',
				'## Experience',
				'',
				'### Ops Lead - 2021 - 06/2024',
				'**Acme**',
				'',
				'## Education',
				'',
				'- BSc, State U, 2015 - 2019',
				'',
				'## Skills',
				'',
				'Excel, SQL',
				'',
				'## Languages',
				'',
				'German (B1), English',
				'',
			].join('\n')
		);
	});

	it('is null when there is nothing beyond a header', () => {
		assert.equal(profileResumeText({ name: 'A', email: 'a@example.org', phone: '1' }), null);
	});
});

describe('profileContact', () => {
	it('maps applicant-profile names onto resume-api contact fields', () => {
		assert.deepEqual(
			profileContact({
				name: ' A ',
				email: 'a@example.org',
				work_authorization: 'EU citizen',
				desired_salary: '70k',
				extra: 'ignored',
			}),
			{
				name: 'A',
				email: 'a@example.org',
				phone: '',
				linkedin: '',
				github: '',
				location: '',
				work_auth: 'EU citizen',
				relocation: '',
				salary_line: '70k',
			}
		);
	});
});
