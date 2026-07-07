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
// downloaded file is verified and the step FAILS if it does not match. Entries
// with neither sha256 nor bytes skip verification with a loud warning (matches
// the runtime ensureModel behaviour).
//
// Usage:
//   node warm-models.mjs --package diffusion-cpp [--root <repoRoot>]
//   PKG=diffusion-cpp node warm-models.mjs
//
// Env:
//   HF_TOKEN   optional; sent as Bearer for huggingface.co URLs (gated repos).

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
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

// Downloads to `dest`. When startByte > 0 it sends a Range header and appends
// to the existing partial (resume). If the server ignores the range and sends
// the whole body (200), we overwrite from scratch so bytes never get spliced.
function downloadOnce (url, dest, name, { redirectsLeft = 10, startByte = 0 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = authHeaders(url)
    if (startByte > 0) headers.range = `bytes=${startByte}-`
    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode
      if ([301, 302, 307, 308].includes(status)) {
        if (redirectsLeft <= 0) return reject(new Error(`too many redirects: ${url}`))
        res.resume()
        const next = new URL(res.headers.location, url).href
        return resolvePromise(downloadOnce(next, dest, name, { redirectsLeft: redirectsLeft - 1, startByte }))
      }
      // Requested range is past the file end — drop the partial and restart.
      if (status === 416) {
        res.resume()
        return reject(Object.assign(new Error(`range not satisfiable for ${url}`), { resetPart: true }))
      }
      if (status !== 200 && status !== 206) {
        res.resume()
        return reject(new Error(`HTTP ${status} for ${url}`))
      }

      const append = status === 206
      const startAt = append ? startByte : 0
      const remaining = Number(res.headers['content-length'] || 0)
      const total = append ? startAt + remaining : remaining
      let received = startAt
      const started = Date.now()
      const progress = setInterval(() => {
        const mb = (received / 1024 / 1024).toFixed(0)
        const pct = total ? ` (${(received / total * 100).toFixed(0)}% of ${(total / 1024 / 1024).toFixed(0)}MB)` : ''
        const rate = ((received - startAt) / 1024 / 1024 / Math.max(1, (Date.now() - started) / 1000)).toFixed(1)
        console.log(`  [warm] ${name}: ${mb}MB${pct} @ ${rate}MB/s`)
      }, PROGRESS_INTERVAL_MS)
      res.on('data', (chunk) => { received += chunk.length })

      const done = (fn, arg) => { clearInterval(progress); fn(arg) }
      pipeline(res, createWriteStream(dest, { flags: append ? 'a' : 'w' }))
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
  // Which URL produced the current .part bytes; we only resume against the same
  // source (a different mirror could serve different bytes).
  let partUrl = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000)
      await new Promise((r) => setTimeout(r, delay))
    }
    const url = urls[attempt % urls.length]
    let startByte = 0
    if (partUrl === url) startByte = await stat(partPath).then((s) => s.size, () => 0)
    else await rm(partPath, { force: true }).catch(() => {})
    try {
      if (startByte > 0) console.log(`  [warm] ${name}: resuming from ${(startByte / 1024 / 1024).toFixed(0)}MB`)
      await downloadOnce(url, partPath, name, { startByte })
      const { size } = await stat(partPath)
      if (size < 1) throw new Error(`downloaded file is empty from ${new URL(url).host}`)
      await rename(partPath, dest)
      return
    } catch (err) {
      lastErr = err
      if (err && err.resetPart) {
        await rm(partPath, { force: true }).catch(() => {})
        partUrl = null
      } else {
        // Keep the partial so the next same-URL attempt resumes from it.
        partUrl = url
      }
      console.log(`  ! attempt ${attempt + 1} failed: ${err.message}`)
    }
  }
  await rm(partPath, { force: true }).catch(() => {})
  throw new Error(`failed to download after ${retries + 1} attempts: ${lastErr && lastErr.message}`)
}

// Streamed so multi-GB models hash correctly: fs.readFile is hard-capped at
// 2 GiB (kIoMaxLength), which most of these model files exceed.
function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
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
