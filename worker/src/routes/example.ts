/**
 * Example CRUD routes
 *
 * Demonstrates OpenAPI route patterns with Zod validation.
 * Replace with your actual business logic.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { okWrapped, createdWrapped, type HadokuAuthContext } from '@wolffm/worker-utils';
import {
	ExampleItemsResponseSchema,
	ExampleItemResponseSchema,
	CreateExampleItemInputSchema,
	UpdateExampleItemInputSchema,
	DeleteResponseSchema,
	ErrorResponseSchema,
} from '../schemas.js';
import type { AppEnv } from '../types.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: {
		authContext: HadokuAuthContext;
	};
}

const app = new OpenAPIHono<RouteContext>();

// ============================================================================
// In-memory store (replace with D1/KV in production)
// ============================================================================

interface ExampleItem {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
}

// Note: In production, use D1 or KV. This is just for demo.
const items = new Map<string, ExampleItem>([
	[
		'demo-1',
		{
			id: 'demo-1',
			name: 'Demo Item',
			description: 'This is a demo item to show the API works',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
	],
]);

// ============================================================================
// GET /items - List all items
// ============================================================================

const listItemsRoute = createRoute({
	method: 'get',
	path: '/items',
	tags: ['Items'],
	summary: 'List all items',
	description: 'Returns a list of all items',
	responses: {
		200: {
			description: 'List of items',
			content: {
				'application/json': {
					schema: ExampleItemsResponseSchema,
				},
			},
		},
	},
});

app.openapi(listItemsRoute, (c) => {
	const itemsList = Array.from(items.values());
	return okWrapped(c, { items: itemsList });
});

// ============================================================================
// GET /items/:id - Get single item
// ============================================================================

const getItemRoute = createRoute({
	method: 'get',
	path: '/items/{id}',
	tags: ['Items'],
	summary: 'Get item by ID',
	description: 'Returns a single item by its ID',
	request: {
		params: z.object({
			id: z.string().openapi({ example: 'demo-1' }),
		}),
	},
	responses: {
		200: {
			description: 'Item found',
			content: {
				'application/json': {
					schema: ExampleItemResponseSchema,
				},
			},
		},
		404: {
			description: 'Item not found',
			content: {
				'application/json': {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

app.openapi(getItemRoute, (c) => {
	const { id } = c.req.valid('param');
	const item = items.get(id);

	if (!item) {
		return c.json(
			{
				success: false as const,
				error: 'Not found',
				message: `Item with id '${id}' not found`,
			},
			404
		);
	}

	return okWrapped(c, { item });
});

// ============================================================================
// POST /items - Create new item (requires auth)
// ============================================================================

const createItemRoute = createRoute({
	method: 'post',
	path: '/items',
	tags: ['Items'],
	summary: 'Create new item',
	description: 'Creates a new item. Requires authentication.',
	request: {
		body: {
			content: {
				'application/json': {
					schema: CreateExampleItemInputSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Item created',
			content: {
				'application/json': {
					schema: ExampleItemResponseSchema,
				},
			},
		},
		401: {
			description: 'Unauthorized',
			content: {
				'application/json': {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

app.openapi(createItemRoute, (c) => {
	// Check auth
	const auth = c.get('authContext');
	if (auth.userType === 'public') {
		return c.json(
			{
				success: false as const,
				error: 'Unauthorized',
				message: 'Authentication required to create items',
			},
			401
		);
	}

	const body = c.req.valid('json');
	const now = new Date().toISOString();
	const id = `item-${Date.now()}`;

	const item: ExampleItem = {
		id,
		name: body.name,
		description: body.description ?? null,
		createdAt: now,
		updatedAt: now,
	};

	items.set(id, item);
	return createdWrapped(c, { item });
});

// ============================================================================
// PUT /items/:id - Update item (requires auth)
// ============================================================================

const updateItemRoute = createRoute({
	method: 'put',
	path: '/items/{id}',
	tags: ['Items'],
	summary: 'Update item',
	description: 'Updates an existing item. Requires authentication.',
	request: {
		params: z.object({
			id: z.string().openapi({ example: 'demo-1' }),
		}),
		body: {
			content: {
				'application/json': {
					schema: UpdateExampleItemInputSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Item updated',
			content: {
				'application/json': {
					schema: ExampleItemResponseSchema,
				},
			},
		},
		401: {
			description: 'Unauthorized',
			content: {
				'application/json': {
					schema: ErrorResponseSchema,
				},
			},
		},
		404: {
			description: 'Item not found',
			content: {
				'application/json': {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

app.openapi(updateItemRoute, (c) => {
	// Check auth
	const auth = c.get('authContext');
	if (auth.userType === 'public') {
		return c.json(
			{
				success: false as const,
				error: 'Unauthorized',
				message: 'Authentication required to update items',
			},
			401
		);
	}

	const { id } = c.req.valid('param');
	const item = items.get(id);

	if (!item) {
		return c.json(
			{
				success: false as const,
				error: 'Not found',
				message: `Item with id '${id}' not found`,
			},
			404
		);
	}

	const body = c.req.valid('json');
	const updated: ExampleItem = {
		...item,
		name: body.name ?? item.name,
		description: body.description !== undefined ? body.description : item.description,
		updatedAt: new Date().toISOString(),
	};

	items.set(id, updated);
	return okWrapped(c, { item: updated });
});

// ============================================================================
// DELETE /items/:id - Delete item (requires admin)
// ============================================================================

const deleteItemRoute = createRoute({
	method: 'delete',
	path: '/items/{id}',
	tags: ['Items'],
	summary: 'Delete item',
	description: 'Deletes an item. Requires admin authentication.',
	request: {
		params: z.object({
			id: z.string().openapi({ example: 'demo-1' }),
		}),
	},
	responses: {
		200: {
			description: 'Item deleted',
			content: {
				'application/json': {
					schema: DeleteResponseSchema,
				},
			},
		},
		401: {
			description: 'Unauthorized',
			content: {
				'application/json': {
					schema: ErrorResponseSchema,
				},
			},
		},
		404: {
			description: 'Item not found',
			content: {
				'application/json': {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

app.openapi(deleteItemRoute, (c) => {
	// Check admin auth
	const auth = c.get('authContext');
	if (auth.userType !== 'admin') {
		return c.json(
			{
				success: false as const,
				error: 'Unauthorized',
				message: 'Admin authentication required to delete items',
			},
			401
		);
	}

	const { id } = c.req.valid('param');

	if (!items.has(id)) {
		return c.json(
			{
				success: false as const,
				error: 'Not found',
				message: `Item with id '${id}' not found`,
			},
			404
		);
	}

	items.delete(id);
	return okWrapped(c, { deleted: true as const, id });
});

export const exampleRoutes = app;
