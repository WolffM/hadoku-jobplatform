# Claude Code Instructions

## CI/CD Deployment Flow

This child app integrates with the hadoku_site parent through an automated deployment pipeline.

### How Publishing Works

```
┌─────────────────────────────────────────────────────────────────────┐
│ CHILD APP (this repo)                                               │
├─────────────────────────────────────────────────────────────────────┤
│ 1. Push to main                                                     │
│         ↓                                                           │
│ 2. .github/workflows/publish.yml runs:                              │
│    - Builds package                                                 │
│    - Bumps version if needed                                        │
│    - Publishes to GitHub Packages (@wolffm/*)                       │
│    - Dispatches `packages_updated` to hadoku_site                   │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ PARENT SITE (hadoku_site)                                           │
├─────────────────────────────────────────────────────────────────────┤
│ 3. update-packages.yml receives dispatch:                           │
│    - Updates package.json/lockfile to latest version                │
│    - Rebuilds micro-frontend bundle (public/mf/<app>/)              │
│    - Regenerates registry.json for cache busting                    │
│    - Commits changes to repo                                        │
│    - Triggers worker deployment if needed                           │
│         ↓                                                           │
│ 4. deploy-workers.yml (if workers changed):                         │
│    - Auto-updates @wolffm/* packages to absolute latest             │
│    - Deploys Cloudflare Workers                                     │
│         ↓                                                           │
│ 5. GitHub Pages deploys static site with new bundles                │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Points

1. **You only push to main** - Everything else is automated
2. **Version bumping is automatic** - Pre-commit hook and CI both handle it
3. **Parent is notified automatically** - Via `packages_updated` dispatch event
4. **Workers always get latest** - `deploy-workers.yml` runs `pnpm update "@wolffm/*" --latest`

### Required Secret

The `HADOKU_SITE_TOKEN` secret must be configured in this repo's GitHub settings:

- Used to authenticate with GitHub Packages
- Used to dispatch events to hadoku_site
- Deployed via hadoku_site admin script: `python scripts/administration.py github-secrets`

## Package Structure

### Required Exports

The parent site expects these exports from `src/entry.tsx`:

```typescript
// Mount the app into a DOM element
export function mount(el: HTMLElement, props?: MountProps): void

// Unmount and cleanup
export function unmount(el: HTMLElement): void
```

### Build Output

After `pnpm build`, the `dist/` folder must contain:

- `index.js` - Main entry point (ES module)
- `style.css` - Component styles

### External Dependencies

These are provided by the parent and must NOT be bundled:

- `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`
- `@wolffm/themes`

See `vite.config.ts` for the rollup externals configuration.

## Worker Packages

If this package is used by a Cloudflare Worker (like `@wolffm/trader-worker`):

1. The worker's `package.json` declares the dependency
2. `deploy-workers.yml` auto-updates to latest before each deploy
3. No manual lockfile updates needed in hadoku_site

### Worker Deployment Safety Net

Even if `update-packages.yml` doesn't run (e.g., local development), workers always deploy with the latest package version because `deploy-workers.yml` runs:

```yaml
- name: Update @wolffm packages to latest
  run: pnpm update "@wolffm/*" --latest --filter <worker-name>
```

This ensures workers never deploy with stale package versions.

## Debugging Deployment Issues

### Package not updating in parent?

1. Check if `publish.yml` succeeded in this repo
2. Check if `update-packages.yml` was triggered in hadoku_site
3. Look for the `packages_updated` dispatch event

### Worker not using new version?

1. Check `deploy-workers.yml` logs for the "Update @wolffm packages" step
2. Verify the package was published to GitHub Packages
3. Check if there are TypeScript/build errors preventing deployment

### Bundle not updating on site?

1. Check `update-packages.yml` for bundle rebuild step
2. Verify `registry.json` was regenerated (cache busting)
3. Check GitHub Pages deployment status

## Naming Convention

| Item         | Convention            | Example             |
| ------------ | --------------------- | ------------------- |
| Package name | `@wolffm/<app-id>`    | `@wolffm/trader`    |
| Repo name    | `hadoku-<app-id>`     | `hadoku-trader`     |
| Bundle path  | `public/mf/<app-id>/` | `public/mf/trader/` |

**Important**: The `hadoku-` prefix is only for GitHub repo names, not package names.
