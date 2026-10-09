/**
 * The built hadoku Fill extension, carried in the dashboard bundle so the
 * owner can install it from any machine they're signed in on. `pnpm build`
 * runs `extension/build.mjs` first, so these are the files in extension/dist
 * at publish time — the same ones `Load unpacked` would read there.
 */
import background from '../../extension/dist/background.js?raw'
import content from '../../extension/dist/content.js?raw'
import manifest from '../../extension/dist/manifest.json?raw'
import { zip } from './zip'

export const fillExtensionVersion = (JSON.parse(manifest) as { version: string }).version

/** Save the extension as `hadoku-fill-<version>.zip`. */
export function downloadFillExtension(): void {
  const bytes = zip([
    { name: 'manifest.json', text: manifest },
    { name: 'background.js', text: background },
    { name: 'content.js', text: content }
  ])
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `hadoku-fill-${fillExtensionVersion}.zip`
  a.click()
  // Revoking in the same tick can cancel the download before Chrome reads it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
