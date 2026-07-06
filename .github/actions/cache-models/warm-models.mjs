#!/usr/bin/env node
'use strict'

// Pre-download every model listed in a package's models.manifest.json into
// packages/<pkg>/test/model BEFORE the integration test run.
//
// Why this exists (one place for "restore -> download-missing -> save"):
//   The integration tests call ensureModel() lazily inside test bodies, which
//   are wrapped in per-test timeouts (brittle). On a COLD cache the heaviest
//   tests (e.g. Wan T2V/I2V) must download 10-14GB inside a single test's
//   timeout and fail. Downloading here — as an ordinary workflow step with no
//   brittle timeout — decouples the multi-GB fetch from the per-test budget.
//
//   On a cache HIT this is a fast no-op (every file is already present and,
//   when sha256 is pinned, verified). The composite's actions/cache@v4
//   post-step then saves the fully-populated dir so the next run restores it
//   instead of re-downloading.
//
// Integrity: when a manifest entry has sha256/bytes pinned, a present file is
// verified (size first, then sha256) and re-downloaded on mismatch; a freshly
// downloaded file is verified and the step FAILS if it does not match. While a
// value is null, verification is skipped with a loud warning (matches the
// runtime ensureModel behaviour).
//
// Usage:
//   node warm-models.mjs --package diffusion-cpp [--root <repoRoot>]
//   PKG=diffusion-cpp node warm-models.mjs
//
// Env:
//   HF_TOKEN   optional; sent as Bearer for huggingface.co URLs (gated repos).

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import https from 'node:https'

function parseArgs (argv) {
  const args = { package: process.env.PKG || null, root: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') args.package = argv[++i]
    else if (argv[i] === '--root') args.root = argv[++i]
  }
  return args
}

function authHeaders (url) {
  const headers = { 'user-agent': 'qvac-warm-models' }
  if (url.includes('huggingface.co') && process.env.HF_TOKEN) {
    headers.authorization = `Bearer ${process.env.HF_TOKEN}`
  }
  return headers
}

// Abort a stalled connection: if no bytes arrive for IDLE_TIMEOUT_MS the
// socket is destroyed and the attempt fails (so downloadWithRetries can retry
// / fall back to a mirror) instead of hanging until the job timeout.
const IDLE_TIMEOUT_MS = Number(process.env.WARM_IDLE_TIMEOUT_MS || 120000)
const PROGRESS_INTERVAL_MS = 30000

function downloadOnce (url, dest, name, redirectsLeft = 10) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(url, { headers: authHeaders(url) }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirectsLeft <= 0) return reject(new Error(`too many redirects: ${url}`))
        res.resume()
        const next = new URL(res.headers.location, url).href
        return resolvePromise(downloadOnce(next, dest, name, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }

      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      const started = Date.now()
      const progress = setInterval(() => {
        const mb = (received / 1024 / 1024).toFixed(0)
        const pct = total ? ` (${(received / total * 100).toFixed(0)}% of ${(total / 1024 / 1024).toFixed(0)}MB)` : ''
        const rate = (received / 1024 / 1024 / Math.max(1, (Date.now() - started) / 1000)).toFixed(1)
        console.log(`  [warm] ${name}: ${mb}MB${pct} @ ${rate}MB/s`)
      }, PROGRESS_INTERVAL_MS)
      res.on('data', (chunk) => { received += chunk.length })

      const done = (fn, arg) => { clearInterval(progress); fn(arg) }
      pipeline(res, createWriteStream(dest))
        .then(() => done(resolvePromise))
        .catch((err) => done(reject, err))
    })
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`idle timeout after ${IDLE_TIMEOUT_MS}ms`))
    })
    req.on('error', reject)
  })
}

async function downloadWithRetries (urls, dest, name, { retries = 3 } = {}) {
  const partPath = dest + '.part'
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000)
      await new Promise((r) => setTimeout(r, delay))
    }
    const url = urls[attempt % urls.length]
    try {
      await downloadOnce(url, partPath, name)
      const { size } = await stat(partPath)
      if (size < 1) throw new Error(`downloaded file is empty from ${new URL(url).host}`)
      await rename(partPath, dest)
      return
    } catch (err) {
      lastErr = err
      await rm(partPath, { force: true }).catch(() => {})
      console.log(`  ! attempt ${attempt + 1} failed: ${err.message}`)
    }
  }
  throw new Error(`failed to download after ${retries + 1} attempts: ${lastErr && lastErr.message}`)
}

async function sha256File (filePath) {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

// Returns { ok, reason } — mirrors runtime ensureModel verification ordering
// (cheap size check before the expensive hash).
async function verify (filePath, entry) {
  if (entry.bytes != null) {
    const { size } = await stat(filePath)
    if (size !== entry.bytes) return { ok: false, reason: `size ${size} != ${entry.bytes}` }
  }
  if (entry.sha256 != null) {
    const actual = await sha256File(filePath)
    if (actual !== entry.sha256) return { ok: false, reason: `sha256 mismatch (${actual})` }
  }
  return { ok: true }
}

function fileExists (p) {
  return stat(p).then(() => true, () => false)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (!args.package) throw new Error('missing --package (or PKG env)')

  const manifestPath = resolve(args.root, 'packages', args.package, 'test/integration/models.manifest.json')
  if (!(await fileExists(manifestPath))) {
    console.log(`[warm] no manifest at ${manifestPath} — skipping (tests will lazy-download)`)
    return
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const modelDir = resolve(args.root, 'packages', args.package, 'test/model')
  await mkdir(modelDir, { recursive: true })

  const entries = Object.entries(manifest.models || {})
  console.log(`[warm] ${args.package}: ${entries.length} model(s) declared; target ${modelDir}`)

  let downloaded = 0
  let skipped = 0

  for (const [name, entry] of entries) {
    const dest = join(modelDir, name)
    const hasIntegrity = entry.sha256 != null || entry.bytes != null

    if (await fileExists(dest)) {
      if (hasIntegrity) {
        const res = await verify(dest, entry)
        if (res.ok) {
          console.log(`[warm] ${name}: present + verified — skip`)
          skipped++
          continue
        }
        console.log(`[warm] ${name}: present but failed integrity (${res.reason}) — re-downloading`)
        await rm(dest, { force: true })
      } else {
        const { size } = await stat(dest)
        if (size > 0) {
          console.log(`[warm] ${name}: present (no sha256/bytes pinned — integrity check SKIPPED) — skip`)
          skipped++
          continue
        }
        await rm(dest, { force: true })
      }
    }

    const urls = Array.isArray(entry.urls) ? entry.urls : []
    if (!urls.length) throw new Error(`[warm] ${name}: no urls in manifest`)

    console.log(`[warm] ${name}: downloading (${urls.length} source(s))...`)
    await downloadWithRetries(urls, dest, name)

    if (hasIntegrity) {
      const res = await verify(dest, entry)
      if (!res.ok) {
        await rm(dest, { force: true })
        throw new Error(`[warm] ${name}: freshly downloaded file failed integrity: ${res.reason}`)
      }
    }
    const { size } = await stat(dest)
    console.log(`[warm] ${name}: ready (${(size / 1024 / 1024).toFixed(1)}MB)`)
    downloaded++
  }

  console.log(`[warm] done: ${downloaded} downloaded, ${skipped} already cached`)
}

main().catch((err) => {
  console.error(err.stack || String(err))
  process.exit(1)
})
