'use strict'

// Shared model-download + cache-verify helpers for the VLA integration tests
// that on Device Farm download their GGUF from a presigned S3 URL bundled into
// testAssets/. Used by addon.test.js (SmolVLA) and groot.test.js, whose copies
// were byte-identical.
//
// NOTE: pi05.test.js intentionally does NOT use this module — its download path
// is hardened for the HF LFS CDN it pulls from (stream-truncation detection via
// Content-Length cross-check, fail-closed sha when bare-crypto is missing, and a
// longer DNS-aware backoff). Folding those guards in here and adopting them for
// all three is a possible follow-up, but would change addon/groot behaviour, so
// it is deliberately left out of this dedup.
//
// Required via a LITERAL relative path so the mobile app bundler statically
// resolves and includes it (a computed require path would not bundle — that is
// why the performance-reporter, which lives outside test/integration/, uses a
// try/catch fallback instead). The per-test files keep their own model-specific
// `_ensureMobileModel` glue (filename + urls key) and call these helpers.

const fs = require('bare-fs')
const path = require('bare-path')

// Read `<name>-urls.json` (presigned URL + sha256 + sizeBytes) from testAssets
// via the mobile harness's global.assetPaths map. Returns null off-device.
function loadUrlsConfig(urlsFile) {
  if (!global.assetPaths) return null
  const candidates = [
    `../../testAssets/${urlsFile}`,
    `../mobile/testAssets/${urlsFile}`,
    `testAssets/${urlsFile}`,
    `../testAssets/${urlsFile}`
  ]
  for (const candidate of candidates) {
    const p = global.assetPaths[candidate]
    if (!p) continue
    try {
      const raw = fs.readFileSync(p.replace('file://', ''), 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      console.log(`[vla-model] failed to read ${candidate}: ${err && err.message}`)
    }
  }
  return null
}

function streamDownload(url, destPath, maxRedirects = 5) {
  const https = require('bare-https')
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    }
    const safeReject = (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    }

    console.log(`[vla-model] downloading: ${url.substring(0, 60)}...`)
    const file = fs.createWriteStream(destPath)
    file.on('error', (err) => {
      file.destroy()
      try {
        fs.unlinkSync(destPath)
      } catch (_) {}
      safeReject(err)
    })

    const req = https.request(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        // Drain the redirect body so bare-https can release the underlying socket.
        if (typeof res.resume === 'function') res.resume()
        file.destroy()
        try {
          fs.unlinkSync(destPath)
        } catch (_) {}
        const location = res.headers.location
        if (location && maxRedirects > 0) {
          streamDownload(location, destPath, maxRedirects - 1).then(safeResolve, safeReject)
          return
        }
        safeReject(new Error(`HTTP ${res.statusCode}: redirect not followed`))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (typeof res.resume === 'function') res.resume()
        file.destroy()
        try {
          fs.unlinkSync(destPath)
        } catch (_) {}
        safeReject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || ''}`))
        return
      }

      const contentLength = parseInt(res.headers['content-length'] || '0', 10)
      const LOG_INTERVAL_BYTES = 50 * 1024 * 1024 // log every 50 MB
      let downloadedBytes = 0
      let nextLogBytes = LOG_INTERVAL_BYTES
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (downloadedBytes >= nextLogBytes) {
          const mb = downloadedBytes / (1024 * 1024)
          const pct =
            contentLength > 0 ? ` (${((downloadedBytes / contentLength) * 100).toFixed(1)}%)` : ''
          console.log(`[vla-model] progress: ${mb.toFixed(0)}MB${pct}`)
          nextLogBytes += LOG_INTERVAL_BYTES
        }
      })
      res.on('error', (err) => {
        file.destroy()
        try {
          fs.unlinkSync(destPath)
        } catch (_) {}
        safeReject(err)
      })
      res.pipe(file)
      file.on('close', () => {
        const mb = downloadedBytes / (1024 * 1024)
        console.log(`[vla-model] downloaded: ${path.basename(destPath)} (${mb.toFixed(1)}MB)`)
        safeResolve()
      })
    })
    req.on('error', (err) => {
      file.destroy()
      try {
        fs.unlinkSync(destPath)
      } catch (_) {}
      safeReject(err)
    })
    req.end()
  })
}

async function downloadFile(url, destPath, maxRedirects = 5, maxRetries = 5) {
  let lastErr = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 500 * 2 ** (attempt - 1)
      console.log(
        `[vla-model] retry ${attempt}/${maxRetries - 1} after ${backoffMs}ms (last: ${lastErr && lastErr.message})`
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
    try {
      await streamDownload(url, destPath, maxRedirects)
      return
    } catch (err) {
      lastErr = err
      if (err && /HTTP \d{3}/.test(err.message || '')) throw err
      try {
        fs.unlinkSync(destPath)
      } catch (_) {}
    }
  }
  throw new Error(
    `[vla-model] download failed after ${maxRetries} attempts: ${lastErr && lastErr.message}`
  )
}

async function sha256File(filePath) {
  let crypto
  try {
    crypto = require('bare-crypto')
  } catch (_) {
    return null
  }
  return await new Promise((resolve, reject) => {
    let hash
    try {
      hash = crypto.createHash('sha256')
    } catch (_) {
      return resolve(null)
    }
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
  })
}

// Validate a cached GGUF against the urls.json (exact size + sha256 when
// present, else a 100MB floor). Returns { ok, reason }.
async function verifyCachedModel(filePath, urlConfig) {
  const stat = fs.statSync(filePath)
  if (urlConfig && Number.isInteger(urlConfig.sizeBytes)) {
    if (stat.size !== urlConfig.sizeBytes) {
      return { ok: false, reason: `size ${stat.size} != expected ${urlConfig.sizeBytes}` }
    }
  } else {
    const cachedMB = stat.size / (1024 * 1024)
    if (cachedMB < 100) {
      return { ok: false, reason: `size ${cachedMB.toFixed(2)}MB < 100MB floor` }
    }
  }
  if (urlConfig && typeof urlConfig.sha256 === 'string' && urlConfig.sha256.length === 64) {
    const got = await sha256File(filePath)
    if (got && got !== urlConfig.sha256.toLowerCase()) {
      return { ok: false, reason: `sha256 ${got} != expected ${urlConfig.sha256}` }
    }
    if (got) console.log(`[vla-model] sha256 verified: ${got.slice(0, 12)}…`)
  }
  return { ok: true }
}

module.exports = { loadUrlsConfig, streamDownload, downloadFile, sha256File, verifyCachedModel }
