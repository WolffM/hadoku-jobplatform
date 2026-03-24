# Job Platform Worker

This is a Cloudflare Worker package that exports factory functions for hadoku_site.

## Architecture

This package is consumed by a thin host worker in `hadoku_site/workers/job-platform-api/`.

```
@wolffm/job-platform-worker (this package)
  └── Exports: createFetchHandler(), createScheduledHandler(), types

hadoku_site/workers/job-platform-api (host worker)
  └── Imports this package and delegates requests
```

## Key Files

- `src/index.ts` - Main exports (factory functions)
- `src/types.ts` - Environment interface (AppEnv)
- `src/schemas.ts` - Zod schemas for OpenAPI
- `src/routes/health.ts` - Health check endpoint
- `src/routes/example.ts` - Example CRUD routes (replace with real logic)

## Development

```bash
# Install dependencies
pnpm install

# Build package
pnpm build

# Run linting
pnpm lint

# Type check
pnpm typecheck
```

## Publishing

Package publishes automatically on push to main via GitHub Actions.

The workflow:

1. Builds the package
2. Bumps version if needed
3. Publishes to GitHub Packages
4. Notifies hadoku_site to update dependencies

## Adding New Routes

1. Create a new file in `src/routes/`
2. Use `OpenAPIHono` and `createRoute` for OpenAPI spec
3. Add schemas to `src/schemas.ts`
4. Mount the routes in `src/index.ts`

## Response Format

This package uses the **wrapped response format**:

```typescript
// Success
{ success: true, data: { ... } }

// Error
{ success: false, error: 'Error Type', message: 'Details' }
```

Use `okWrapped()` and `createdWrapped()` helpers from `@wolffm/worker-utils`.

## Authentication

Authentication is handled by `createHadokuAuth()` middleware:

- `X-User-Key` header contains the API key
- `authContext.userType` is `'admin'`, `'friend'`, or `'public'`
- Check auth in route handlers before mutations

## Environment Variables

Set in the host worker's `wrangler.toml`:

| Variable                   | Description                         |
| -------------------------- | ----------------------------------- |
| `ADMIN_KEYS`               | JSON array of admin API keys        |
| `FRIEND_KEYS`              | JSON array of friend API keys       |
| `JOB_PLATFORM_API_KEY` | Service-specific API key (optional) |

## Deployment

After publishing, the host worker in hadoku_site will automatically:

1. Update to the latest version via `update-packages.yml`
2. Deploy to Cloudflare via `deploy-workers.yml`
