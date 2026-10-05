// Bundles the extension into extension/dist, which is what Chrome loads
// ("Load unpacked" → this folder's dist/). Classic scripts, not modules: MV3
// content scripts cannot be ES modules.
import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'dist')
await mkdir(out, { recursive: true })
await build({
  entryPoints: {
    background: join(here, 'src/background.ts'),
    content: join(here, 'src/content.ts')
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: out,
  logLevel: 'warning'
})
await copyFile(join(here, 'manifest.json'), join(out, 'manifest.json'))
console.log(`built ${out}`)
