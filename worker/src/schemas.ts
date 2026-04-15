import { z } from '@hono/zod-openapi';
import { DetailedErrorResponseSchema, createSuccessResponseSchema } from '@wolffm/worker-utils';

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

export const ProfileSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		keywords: z.array(z.string()),
		target_companies: z.array(z.string()),
		role_types: z.array(z.string()),
		min_salary: z.number().nullable(),
		remote_pref: z.enum(['remote', 'hybrid', 'onsite', 'any']),
		experience_levels: z.array(z.string()),
		created_at: z.string(),
	})
	.openapi('Profile');

export const CreateProfileSchema = z
	.object({
		name: z.string().min(1),
		keywords: z.array(z.string()).default([]),
		target_companies: z.array(z.string()).default([]),
		role_types: z.array(z.string()).default([]),
		min_salary: z.number().nullable().default(null),
		remote_pref: z.enum(['remote', 'hybrid', 'onsite', 'any']).default('any'),
		experience_levels: z.array(z.string()).default([]),
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
		title_match: z.number(),
		keyword_match: z.number(),
		company_boost: z.number(),
		seniority_match: z.number(),
		remote_match: z.number(),
		salary_match: z.number(),
	})
	.openapi('ScoreBreakdown');

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
		score: z.number(),
		score_breakdown: ScoreBreakdownSchema,
	})
	.openapi('JobSummary');

export const JobDetailSchema = JobSummarySchema.extend({
	job_type: z.string(),
	description: z.string(),
	application_url: z.string().nullable(),
	department: z.string().nullable(),
	scraper_used: z.string().nullable(),
	run_id: z.string().nullable(),
}).openapi('JobDetail');

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
		source: z.enum(['greenhouse', 'lever', 'linkedin']),
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

export const UserCompanySchema = z
	.object({
		id: z.string(),
		target_id: z.number().int(),
		ats: z.string(),
		slug: z.string(),
		display_name: z.string(),
		added_at: z.string(),
	})
	.openapi('UserCompany');

export const CreateCompanySchema = z
	.object({
		display_name: z.string().min(1),
		use_llm: z.boolean().default(true),
	})
	.openapi('CreateCompany');

export const CompaniesResponseSchema = S(
	z.object({ companies: z.array(UserCompanySchema) })
).openapi('CompaniesResponse');

export const CreateCompanyResponseSchema = S(
	z.object({
		companies: z.array(UserCompanySchema),
		skipped: z.array(
			z.object({ ats: z.string(), slug: z.string(), reason: z.string().optional() })
		),
		search_triggered: z.boolean(),
	})
).openapi('CreateCompanyResponse');

export const DeleteCompanyResponseSchema = S(
	z.object({ deleted: z.literal(true), id: z.string() })
).openapi('DeleteCompanyResponse');
