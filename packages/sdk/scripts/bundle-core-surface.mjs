// Bundles @qvac/core's value-clean subpaths (surface, plugin-utils, models) into
// the SDK's own dist as JavaScript, so the Node client never imports core's `.ts`
// at runtime (Node refuses to strip types inside node_modules). Core stays
// `.ts`-only and Bare-only; only the SDK's build inlines a compiled copy.
//
// `packages: 'external'` keeps every node_modules dependency (zod, @qvac/error,
// @qvac/logging, ...) external so it resolves from the SDK's own node_modules at
// runtime, while core's own relative module graph is inlined. The Bare worker is
// unaffected: it keeps importing `@qvac/core/*` and Bare strips the `.ts` at load.

import { build } from 'esbuild'
import { createRequire } from 'module'
import path from 'path'

const require = createRequire(import.meta.url)

// Resolve the on-disk source for each subpath from core's own exports map, so a
// change to core's internal layout does not need a change here.
const corePkgPath = require.resolve('@qvac/core/package')
const coreDir = path.dirname(corePkgPath)
const coreExports = require(corePkgPath).exports

function entryFor(subpath) {
  const target = coreExports[subpath]
  if (!target) throw new Error(`@qvac/core has no "${subpath}" export`)
  return path.resolve(coreDir, target)
}

await build({
  entryPoints: {
    surface: entryFor('./surface'),
    'plugin-utils': entryFor('./plugin-utils'),
    models: entryFor('./models')
  },
  outdir: 'dist/src/_vendor',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
  logLevel: 'warning'
})
