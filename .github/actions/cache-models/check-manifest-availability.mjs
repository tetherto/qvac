#!/usr/bin/env node
'use strict'

// Verify each pinned model in a package's models.manifest.json is still
// AVAILABLE at its source and that its upstream content address still matches
// the committed sha256/bytes — WITHOUT downloading the model body.
//
// Why this exists:
//   Removing the shared `.github/actions/cache-models/**` path from every
//   addon's PR trigger means a change to the shared caching action no longer
//   fans out a full integration run to each addon. This check is the cheap
//   replacement safety net: per addon manifest it proves that (a) every pinned
//   source still resolves and (b) its immutable content address still equals
//   the committed pin. Any drift or inaccessible source fails the job.
//
// Scope:
//   Hugging Face LFS sources only. A huggingface.co `/resolve/` URL exposes the
//   canonical content address as `X-Linked-ETag` (sha256) and `X-Linked-Size`
//   (bytes) on the redirect response, so accessibility + fingerprint can be
//   verified from headers alone — no body transfer. Non-HF-LFS entries (e.g.
//   S3-staged parakeet models) are reported as `skipped`; those sets are
//   covered by the canary integration leg instead.
//
// Security:
//   Reuses the hardened helpers from warm-models.mjs — the HF_TOKEN is sent
//   ONLY to the exact huggingface.co host, the redirect is never followed (so a
//   bearer token can never be replayed to a signed CDN), and every URL is
//   redacted in logs/errors.
//
// Usage:
//   node check-manifest-availability.mjs --package diffusion-cpp [--group base] [--root <repoRoot>]
//
// Env:
//   HF_TOKEN  optional; forwarded as Bearer ONLY to huggingface.co (gated repos).

import https from 'node:https'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authHeaders, redactUrl, redactUrlsInText } from './warm-models.mjs'

export function parseArgs(argv) {
  const args = {
    package: process.env.PKG || null,
    root: process.cwd(),
    group: process.env.MODEL_GROUP || ''
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') args.package = argv[++i]
    else if (argv[i] === '--root') args.root = argv[++i]
    else if (argv[i] === '--group') args.group = argv[++i]
  }
  return args
}

export function isHuggingFaceLfsUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'huggingface.co' &&
      parsed.pathname.includes('/resolve/')
    )
  } catch (_) {
    return false
  }
}

// HF exposes the canonical content address of an LFS object as X-Linked-ETag
// (the sha256) and X-Linked-Size (bytes) on the 3xx that points at the CDN.
export function linkedIntegrity(headers) {
  const rawEtag = headers['x-linked-etag']
  const etag = typeof rawEtag === 'string' ? rawEtag.replace(/^W\//, '').replace(/"/g, '') : ''
  const rawSize = Number(headers['x-linked-size'])
  return {
    sha256: /^[0-9a-f]{64}$/i.test(etag) ? etag.toLowerCase() : undefined,
    bytes: Number.isInteger(rawSize) && rawSize > 0 ? rawSize : undefined
  }
}

const IDLE_TIMEOUT_MS = Number(process.env.CHECK_IDLE_TIMEOUT_MS || 30000)

// Read ONLY the response headers for the huggingface.co /resolve/ URL. The
// redirect is deliberately NOT followed: the linked-integrity headers live on
// the 3xx itself, and not following guarantees the bearer token is never
// replayed to the signed CDN target. The body is discarded, so no model bytes
// are transferred.
export function fetchHeaders(url, { requester = https } = {}) {
  return new Promise((resolvePromise, reject) => {
    let req
    try {
      req = requester.get(url, { headers: authHeaders(url) }, (res) => {
        const { statusCode, headers } = res
        try {
          res.resume()
        } catch (_) {
          if (typeof res.destroy === 'function') res.destroy()
        }
        resolvePromise({ statusCode, headers })
      })
    } catch (err) {
      return reject(new Error(redactUrlsInText(err.message)))
    }
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`idle timeout after ${IDLE_TIMEOUT_MS}ms`))
    })
    req.on('error', (err) => reject(new Error(redactUrlsInText(err.message))))
  })
}

// Returns { status, reason } where status is one of:
//   'ok'           — reachable and upstream content address matches the pin
//   'drift'        — reachable but sha256/bytes disagree, or entry not pinned
//   'inaccessible' — source did not resolve / no canonical metadata
//   'skipped'      — no HF LFS source to verify from headers (canary covers it)
export async function checkEntry(name, entry, { fetch = fetchHeaders } = {}) {
  const urls = Array.isArray(entry.urls) ? entry.urls : []
  const hfUrl = urls.find(isHuggingFaceLfsUrl)
  if (!hfUrl) {
    return { status: 'skipped', reason: 'no huggingface.co LFS source (covered by canary)' }
  }
  if (entry.sha256 == null || entry.bytes == null) {
    return { status: 'drift', reason: 'entry is not fully pinned (sha256/bytes missing)' }
  }

  let res
  try {
    res = await fetch(hfUrl)
  } catch (err) {
    return { status: 'inaccessible', reason: redactUrlsInText(err.message) }
  }

  const { statusCode, headers } = res
  const isRedirect = [301, 302, 307, 308].includes(statusCode)
  if (!isRedirect) {
    if (statusCode === 200) {
      // A direct 200 (small, non-LFS inline file) exposes no linked content
      // address; it cannot be fingerprinted from headers alone.
      return { status: 'skipped', reason: 'non-LFS 200 response (covered by canary)' }
    }
    return { status: 'inaccessible', reason: `HTTP ${statusCode} for ${redactUrl(hfUrl)}` }
  }

  const observed = linkedIntegrity(headers)
  if (!observed.sha256 || !observed.bytes) {
    // The source resolved (a 3xx means HF located the object), but this
    // redirect carries no linked content address — e.g. a non-LFS sidecar
    // served via redirect (sharded `.tensors.txt` index files) or an
    // xet-backed object. It's reachable but not fingerprintable from headers,
    // so treat it like other unfingerprintable sources: skip, leaving content
    // verification to the canary integration leg.
    return {
      status: 'skipped',
      reason: `redirect without linked content address for ${redactUrl(hfUrl)} (covered by canary)`
    }
  }
  if (observed.sha256 !== entry.sha256) {
    return { status: 'drift', reason: `upstream sha256 ${observed.sha256} != pinned ${entry.sha256}` }
  }
  if (observed.bytes !== entry.bytes) {
    return { status: 'drift', reason: `upstream bytes ${observed.bytes} != pinned ${entry.bytes}` }
  }
  return { status: 'ok', reason: '' }
}

export async function checkManifest(args, { fetch = fetchHeaders } = {}) {
  if (!args.package) throw new Error('missing --package (or PKG env)')

  const manifestPath = resolve(
    args.root,
    'packages',
    args.package,
    'test/integration/models.manifest.json'
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const all = Object.entries(manifest.models || {})
  const entries = args.group ? all.filter(([, entry]) => entry.group === args.group) : all

  const results = []
  for (const [name, entry] of entries) {
    const result = await checkEntry(name, entry, { fetch })
    results.push({ name, ...result })
    console.log(`[check] ${name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`)
  }

  const failures = results.filter((r) => r.status === 'drift' || r.status === 'inaccessible')
  const ok = results.filter((r) => r.status === 'ok').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  console.log(
    `[check] summary: package=${args.package} group=${args.group || 'all'} ` +
      `ok=${ok} skipped=${skipped} failed=${failures.length}`
  )
  return { results, failures, ok, skipped }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  checkManifest(parseArgs(process.argv.slice(2)))
    .then(({ failures }) => {
      if (failures.length) process.exit(1)
    })
    .catch((err) => {
      console.error(redactUrlsInText(err.stack || String(err)))
      process.exit(1)
    })
}
