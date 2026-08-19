import { z } from '@hono/zod-openapi';
import { DetailedErrorResponseSchema, createSuccessResponseSchema } from '@wolffm/worker-utils';
import { IC_LEVELS, MANAGER_LEVELS } from './roleClassify.js';

export const ErrorResponseSchema = DetailedErrorResponseSchema;
const S = createSuccessResponseSchema;

// ============================================================================
// Health
// ============================================================================

export const HealthResponseSchema = z
	.object({
		status: z.enum(['healthy', 'degraded', 'unhealthy']),
		service: z.literal('jobplatform-worker'),
		timestamp: z.string(),
	})
	.openapi('HealthResponse');

// ============================================================================
// Profiles
// ============================================================================

// The two orthogonal axes of "what kind of role am I looking for". `track` is a
// hard filter on jobs.role_track; `levels` is a graded score factor. See
// worker/src/roleClassify.ts for how a posting gets classified onto them.
export const ProfileTrackSchema = z.enum(['ic', 'manager', 'either']).openapi('ProfileTrack');
export const RoleLevelSchema = z.enum([...IC_LEVELS, ...MANAGER_LEVELS]).openapi('RoleLevel');

export const ProfileSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		keywords: z.array(z.string()),
		track: ProfileTrackSchema,
		levels: z.array(RoleLevelSchema),
		remote_pref: z.enum(['remote', 'hybrid', 'onsite', 'any']),
		created_at: z.string(),
		// True for the shared default profile (id 'default') — whether the caller
		// is seeing the code seed or their own edited copy. Regular profiles omit
		// it (defaults to false).
		is_default: z.boolean().default(false),
	})
	.openapi('Profile');

export const CreateProfileSchema = z
	.object({
		name: z.string().min(1),
		keywords: z.array(z.string()).default([]),
		track: ProfileTrackSchema.default('either'),
		levels: z.array(RoleLevelSchema).default([]),
		remote_pref: z.enum(['remote', 'hybrid', 'onsite', 'any']).default('any'),
	})
	.openapi('CreateProfile');

export const UpdateProfileSchema = CreateProfileSchema.partial().openapi('UpdateProfile');

export const ProfilesResponseSchema = S(z.object({ profiles: z.array(ProfileSchema) })).openapi(
	'ProfilesResponse'
);
export const ProfileResponseSchema = S(z.object({ profile: ProfileSchema })).openapi(
	'ProfileResponse'
);
export const DeleteResponseSchema = S(
	z.object({ deleted: z.literal(true), id: z.string() })
).openapi('DeleteResponse');

// ============================================================================
// Jobs
// ============================================================================

export const ScoreBreakdownSchema = z
	.object({
		relevance: z.number(),
		level_match: z.number(),
		geo_fit: z.number(),
		comp_fit: z.number(),
		stack_fit: z.number(),
		domain_interest: z.number(),
		discipline_factor: z.number(),
	})
	.openapi('ScoreBreakdown');

/** As classified at ingest. 'unknown' only for a blank title. */
export const RoleTrackSchema = z.enum(['ic', 'manager', 'unknown']).openapi('RoleTrack');

// Triage states (V2). 'new' is implicit — the absence of a job_states row.
// Code reads/writes only 'interested' | 'dismissed' | 'saved' | 'applied'.
// V5 will add 'offered' | 'rejected'. The DB column is unconstrained TEXT,
// so adding states later is a code-only change.
export const JobStateSchema = z
	.enum(['interested', 'dismissed', 'saved', 'applied'])
	.openapi('JobState');
export type JobStateValue = z.infer<typeof JobStateSchema>;

// Read-only state on returned jobs. 'new' surfaces here when there's no row.
export const JobStateReadSchema = z
	.enum(['new', 'interested', 'dismissed', 'saved', 'applied'])
	.openapi('JobStateRead');

export const JobSummarySchema = z
	.object({
		id: z.string(),
		title: z.string(),
		company: z.string(),
		location: z.string(),
		workplace_type: z.string(),
		salary_min: z.number().nullable(),
		salary_max: z.number().nullable(),
		source_site: z.string(),
		url: z.string(),
		posted_date: z.string().nullable(),
		scraped_at: z.string(),
		ats: z.string().nullable(),
		slug: z.string().nullable(),
		role_track: RoleTrackSchema,
		role_level: RoleLevelSchema.nullable(),
		score: z.number(),
		score_breakdown: ScoreBreakdownSchema,
		// 'new' when no row in job_states for the caller, or null when
		// unauthenticated (we don't know which user is asking).
		state: JobStateReadSchema.nullable(),
		// The caller's curation vote + reasons, when authenticated; feed-only.
		vote: z
			.union([z.literal(1), z.literal(-1)])
			.nullable()
			.optional(),
		vote_reasons: z.array(z.string()).optional(),
	})
	.openapi('JobSummary');

export const JobDetailSchema = JobSummarySchema.extend({
	job_type: z.string(),
	description: z.string(),
	application_url: z.string().nullable(),
	department: z.string().nullable(),
	scraper_used: z.string().nullable(),
	run_id: z.string().nullable(),
	state_updated_at: z.string().nullable(),
}).openapi('JobDetail');

// PUT /jobs/:id/state — body
export const FEEDBACK_REASONS = [
	// downvote-flavored
	'pay',
	'location',
	'stack',
	'domain',
	'level',
	'company',
	// upvote-flavored
	'comp',
	'fit',
	'other',
] as const;

export const SetJobFeedbackSchema = z
	.object({
		vote: z.union([z.literal(1), z.literal(-1)]),
		// Multi-select: a posting can be wrong on several axes at once.
		reasons: z.array(z.enum(FEEDBACK_REASONS)).max(9).default([]),
	})
	.openapi('SetJobFeedback');

export const JobFeedbackResponseSchema = S(
	z.object({
		job_id: z.string(),
		vote: z.union([z.literal(1), z.literal(-1)]).nullable(),
		reasons: z.array(z.string()),
		updated_at: z.string(),
	})
).openapi('JobFeedbackResponse');

export const SetJobStateSchema = z
	.object({
		state: JobStateSchema,
		// Optional: the resume-api variant slug of the packet sent with this
		// application. Recorded (typically on "applied") so the state row remembers
		// what went out. Ignored for states where it makes no sense.
		variant_slug: z.string().optional(),
	})
	.openapi('SetJobState');

export const JobStateResponseSchema = S(
	z.object({
		job_id: z.string(),
		state: JobStateReadSchema,
		updated_at: z.string(),
	})
).openapi('JobStateResponse');

export const JobsResponseSchema = S(
	z.object({
		jobs: z.array(JobSummarySchema),
		total: z.number(),
		page: z.number(),
		limit: z.number(),
		has_more: z.boolean(),
	})
).openapi('JobsResponse');

export const JobResponseSchema = S(z.object({ job: JobDetailSchema })).openapi('JobResponse');

// ============================================================================
// V3 — tailored application packets (proxied to resume-api via service binding)
// ============================================================================

export const GenerateResumeRequestSchema = z
	.object({
		/** Block-selection hint forwarded to resume-api (e.g. "ml", "leadership"). */
		profile_type: z.string().optional(),
		/** false skips the pass-2 bullet rewrite (faster, less tailored). */
		tailor: z.boolean().optional(),
	})
	.openapi('GenerateResumeRequest');

export const GenerateResumeResponseSchema = S(
	z.object({
		resume_markdown: z.string(),
		blocks_used: z.array(z.string()),
		cached: z.boolean(),
	})
).openapi('GenerateResumeResponse');

export const GenerateCoverLetterRequestSchema = z
	.object({
		tone: z.enum(['formal', 'conversational']).optional(),
	})
	.openapi('GenerateCoverLetterRequest');

export const GenerateCoverLetterResponseSchema = S(
	z.object({
		cover_letter_markdown: z.string(),
		cached: z.boolean(),
	})
).openapi('GenerateCoverLetterResponse');

// ============================================================================
// Ingest
// ============================================================================

const IngestSalarySchema = z
	.object({
		min: z.number().nullable(),
		max: z.number().nullable(),
		currency: z.string().nullable(),
		period: z.string().nullable(),
		text: z.string().nullable(),
	})
	.nullable()
	.optional();

export const IngestJobSchema = z.object({
	id: z.string(),
	url: z.string(),
	source_site: z.string(),
	title: z.string(),
	company: z.string(),
	location: z.string(),
	job_type: z.string().default('unknown'),
	workplace_type: z.string().default('unknown'),
	salary: IngestSalarySchema,
	description: z.string().default(''),
	posted_date: z.string().nullable().optional(),
	application_url: z.string().nullable().optional(),
	department: z.string().nullable().optional(),
	scraper_used: z.string().nullable().optional(),
	raw: z.record(z.string(), z.unknown()).default({}),
});

export const IngestPayloadSchema = z
	.object({
		jobs: z.array(IngestJobSchema),
		// A free-form batch label (greenhouse/lever/ashby/linkedin/remotive/
		// remoteok/themuse/…). NOT an enum — every provider the scraper adds
		// would otherwise 400 the whole batch here (this silently dropped ashby
		// and all keyword-source jobs). Per-job `source_site` is authoritative.
		source: z.string(),
		batch_number: z.number().int().positive(),
		is_final: z.boolean(),
		search_term: z.string().optional(),
	})
	.openapi('IngestPayload');

export const IngestResponseSchema = S(
	z.object({
		accepted: z.number(),
		skipped: z.number(),
		batch_number: z.number(),
		is_final: z.boolean(),
	})
).openapi('IngestResponse');

// ============================================================================
// Companies (user company subscriptions)
// ============================================================================

export const ProfileCompanySchema = z
	.object({
		id: z.string(),
		ats: z.string(),
		slug: z.string(),
		display_name: z.string(),
		added_at: z.string(),
	})
	.openapi('ProfileCompany');

export const AddProfileCompanySchema = z
	.object({
		ats: z.string().min(1),
		slug: z.string().min(1),
		display_name: z.string().min(1),
	})
	.openapi('AddProfileCompany');

export const ProbeCompanySchema = z
	.object({
		slugs: z.array(z.string().min(1)).min(1),
		providers: z.array(z.string()).optional(),
	})
	.openapi('ProbeCompany');

export const ProviderHitSchema = z
	.object({
		ats: z.string(),
		company_name: z.string().nullable(),
		n_jobs: z.number().int(),
		sample_titles: z.array(z.string()),
	})
	.openapi('ProviderHit');

export const ProbeCompanyResponseSchema = S(
	z.object({
		results: z.array(z.object({ slug: z.string(), hits: z.array(ProviderHitSchema) })),
	})
).openapi('ProbeCompanyResponse');

export const MatchCompanySchema = z
	.object({
		names: z.array(z.string().min(1)).min(1),
		providers: z.array(z.string()).optional(),
	})
	.openapi('MatchCompany');

export const CompanyMatchSchema = z
	.object({
		query: z.string(),
		matched: z.boolean(),
		ats: z.string().nullable(),
		slug: z.string().nullable(),
		company_name: z.string().nullable(),
		n_jobs: z.number().int(),
		sample_titles: z.array(z.string()),
		domain: z.string().nullable(),
	})
	.openapi('CompanyMatch');

export const MatchCompanyResponseSchema = S(
	z.object({ results: z.array(CompanyMatchSchema) })
).openapi('MatchCompanyResponse');

export const ProfileCompaniesResponseSchema = S(
	z.object({ companies: z.array(ProfileCompanySchema) })
).openapi('ProfileCompaniesResponse');

export const AddProfileCompanyResponseSchema = S(
	z.object({
		company: ProfileCompanySchema,
		search_triggered: z.boolean(),
	})
).openapi('AddProfileCompanyResponse');

export const DeleteCompanyResponseSchema = S(
	z.object({ deleted: z.literal(true), id: z.string() })
).openapi('DeleteCompanyResponse');
