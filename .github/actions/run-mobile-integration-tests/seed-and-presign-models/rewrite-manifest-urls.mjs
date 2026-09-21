'use strict'
// Prepend the US-bucket presigned URL to each model's urls[] in diffusion's
// on-device manifest before the app is built, keeping the original source(s) as
// fallbacks. sha256/bytes pins are untouched, so integrity checks are unchanged.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function env(name) {
  const v = process.env[name]
  if (!v) throw new Error(`[rewrite] required env ${name} is not set`)
  return v
}

// Prepend each presigned URL to the matching model's urls[], keeping the
// original source(s) as ordered fallbacks and leaving sha256/bytes pins intact.
// Returns the number of models repointed. Mutates `manifest` in place.
function rewriteManifest(manifest, map) {
  if (!manifest || !manifest.models) {
    throw new Error('[rewrite] manifest has no models object')
  }

  let rewritten = 0
  for (const [name, presignedUrl] of Object.entries(map)) {
    const entry = manifest.models[name]
    if (!entry) {
      console.log(`[rewrite] ${name}: not in manifest, skipping`)
      continue
    }
    const existing = Array.isArray(entry.urls) ? entry.urls : []
    const fallbacks = existing.filter((u) => u !== presignedUrl)
    entry.urls = [presignedUrl, ...fallbacks]
    rewritten++
  }
  return rewritten
}

function main() {
  const manifestPath = env('MANIFEST_PATH')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const map = JSON.parse(readFileSync(env('URL_MAP'), 'utf8'))
  const rewritten = rewriteManifest(manifest, map)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[rewrite] ${rewritten} model URL(s) repointed to US bucket in ${manifestPath}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { rewriteManifest }
