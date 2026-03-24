/**
 * Zod schemas for OpenAPI spec generation
 *
 * These define the request/response shapes for all API endpoints.
 * Uses @wolffm/worker-utils for shared schema patterns.
 */

import { z } from '@hono/zod-openapi';
import {
	DetailedErrorResponseSchema,
	createSuccessResponseSchema,
} from '@wolffm/worker-utils';

// ============================================================================
// Re-export shared schemas
// ============================================================================

export const ErrorResponseSchema = DetailedErrorResponseSchema;

// Custom health response for this worker
export const HealthResponseSchema = z
	.object({
		status: z.enum(['healthy', 'degraded', 'unhealthy']),
		service: z.literal('job-platform-worker'),
		timestamp: z.string(),
		version: z.string().optional(),
	})
	.openapi('HealthResponse');

// Success wrapper helper
export const SuccessResponseSchema = createSuccessResponseSchema;

// ============================================================================
// Example Entity Schemas (customize for your app)
// ============================================================================

export const ExampleItemSchema = z
	.object({
		id: z.string().openapi({ example: 'item-123' }),
		name: z.string().openapi({ example: 'Example Item' }),
		description: z.string().nullable().openapi({ example: 'A sample item' }),
		createdAt: z.string().openapi({ example: '2025-01-21T00:00:00.000Z' }),
		updatedAt: z.string().openapi({ example: '2025-01-21T00:00:00.000Z' }),
	})
	.openapi('ExampleItem');

// ============================================================================
// Response Schemas
// ============================================================================

export const ExampleItemsResponseSchema = SuccessResponseSchema(
	z.object({
		items: z.array(ExampleItemSchema),
	})
).openapi('ExampleItemsResponse');

export const ExampleItemResponseSchema = SuccessResponseSchema(
	z.object({
		item: ExampleItemSchema,
	})
).openapi('ExampleItemResponse');

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateExampleItemInputSchema = z
	.object({
		name: z.string().min(1).openapi({ example: 'New Item' }),
		description: z.string().optional().openapi({ example: 'Item description' }),
	})
	.openapi('CreateExampleItemInput');

export const UpdateExampleItemInputSchema = z
	.object({
		name: z.string().optional().openapi({ example: 'Updated Item' }),
		description: z.string().nullable().optional().openapi({ example: 'Updated description' }),
	})
	.openapi('UpdateExampleItemInput');

// ============================================================================
// Delete Response
// ============================================================================

export const DeleteResponseSchema = SuccessResponseSchema(
	z.object({
		deleted: z.literal(true),
		id: z.string(),
	})
).openapi('DeleteResponse');
