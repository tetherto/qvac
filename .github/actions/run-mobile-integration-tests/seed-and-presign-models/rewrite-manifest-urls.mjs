'use strict'
// Prepend the US-bucket presigned URL to each model's urls[] in diffusion's
// on-device manifest before the app is built, keeping the original source(s) as
// fallbacks. sha256/bytes pins are untouched, so integrity checks are unchanged.
import { readFileSync, writeFileSync } from 'node:fs'

function env(name) {
  const v = process.env[name]
  if (!v) throw new Error(`[rewrite] required env ${name} is not set`)
  return v
}

const MANIFEST_PATH = env('MANIFEST_PATH')
const URL_MAP = env('URL_MAP')

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const map = JSON.parse(readFileSync(URL_MAP, 'utf8'))
  if (!manifest || !manifest.models) {
    throw new Error(`[rewrite] manifest ${MANIFEST_PATH} has no models object`)
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

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[rewrite] ${rewritten} model URL(s) repointed to US bucket in ${MANIFEST_PATH}`)
}

main()
