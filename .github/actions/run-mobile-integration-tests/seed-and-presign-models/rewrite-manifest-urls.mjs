'use strict'
// Bake US-bucket presigned URLs into diffusion's integration manifest before the
// mobile app is built (QVAC-23466 pilot).
//
// Diffusion downloads models ON-DEVICE from test/integration/models.manifest.json
// (statically bundled into the app by bare-pack), so to make the phone fetch from
// the us-west-2 bucket the manifest must be rewritten before the build step.
//
// For every model in URL_MAP we prepend the presigned US URL to that model's
// urls[] and keep the original source(s) as fallbacks after it. sha256/bytes pins
// are untouched, so the on-device integrity check is unchanged (the mirrored
// bytes are the same model). Runs finish well within the presign lifetime, so the
// US URL is the one that actually serves; the retained HF/github URLs are only a
// safety net.
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
