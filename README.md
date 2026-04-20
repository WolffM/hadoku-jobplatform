# @wolffm/jobplatform

Job hunting pipeline: scrape postings from multiple ATS sources, score them against configurable role profiles, triage + track applications, and eventually auto-generate tailored resumes and cover letters. Mounts as a micro-frontend in `hadoku_site` at `/jobs/`.

Companion package `@wolffm/jobplatform-worker` under `worker/` provides the Cloudflare Worker API.

**Canonical roadmap, data model, scoring algorithm, and open questions: [`ARCHITECTURE.md`](./ARCHITECTURE.md).**

## Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Build for production
pnpm build

# Lint and format
pnpm lint:fix
pnpm format
```

### Logging

**Important**: Use the logger from `@wolffm/task-ui-components` instead of `console.log`:

```typescript
import { logger } from '@wolffm/task-ui-components'

logger.info('Message', { key: 'value' })
logger.error('Error occurred', error)
```

Available methods: `logger.info()`, `logger.error()`, `logger.warn()`, `logger.debug()`

Logs are only visible in dev mode or when authenticated as admin.

## Integration

This app is a child component of the [hadoku_site](https://github.com/WolffM/hadoku_site) parent application.

### Props

```typescript
interface JobPlatformProps {
  theme?: string // 'light', 'dark', 'coffee-dark', etc.
  apiKey?: string // optional — if omitted, `credentials: 'include'` is used and hadoku_site's edge-router injects auth from the session cookie
}
```

### Mounting

```typescript
import { mount, unmount } from '@wolffm/jobplatform'

// Mount the app
mount(document.getElementById('app-root'), {
  theme: 'ocean-dark'
})

// Unmount when done
unmount(document.getElementById('app-root'))
```

## Deployment

Pushes to `main` automatically:

1. Build and publish to GitHub Packages
2. Notify parent site to update
3. Parent pulls new version and redeploys

## Theme Integration

Use CSS variables from `@wolffm/themes` for all colors:

```css
background-color: var(--color-bg);
color: var(--color-text);
border-color: var(--color-border);
```

Set theme attributes in your root component:

```typescript
containerRef.current?.setAttribute('data-theme', theme)
containerRef.current?.setAttribute('data-dark-theme', isDarkTheme ? 'true' : 'false')
```
