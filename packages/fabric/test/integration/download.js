'use strict'

// Self-contained model downloader for the fabric integration tests.
// Deliberately depends only on bare-* modules so this harness does not need
// the consumer packages' internal test utilities.

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')

const TRANSIENT_ERROR_CODES = new Set([
  'EAI_NODATA', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ESIZE'
])

function isTransientError (err) {
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true
  if (err.statusCode) {
    const s = err.statusCode
    return s === 408 || s === 429 || s >= 500
  }
  return false
}

function urlHost (url) {
  try { return new URL(url).host } catch (_) { return url }
}

function downloadFileOnce (url, dest, opts = {}) {
  const { timeoutMs = 30_000, idleTimeoutMs = 30_000, maxRedirects = 10, _redirectCount = 0 } = opts
  return new Promise((resolve, reject) => {
    let settled = false
    let handedOff = false

    const safeResolve = () => { if (!settled) { settled = true; resolve() } }
    const safeReject = (err) => { if (!settled) { settled = true; reject(err) } }
    const cleanupAndReject = (err) => {
      if (settled || handedOff) { if (!settled) safeReject(err); return }
      fs.unlink(dest, () => safeReject(err))
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => { file.destroy(); cleanupAndReject(err) })

    const reqTimer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`Request timeout after ${timeoutMs}ms from ${urlHost(url)}`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)

    const req = https.request(url, response => {
      clearTimeout(reqTimer)

      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        if (_redirectCount >= maxRedirects) {
          fs.unlink(dest, () => safeReject(new Error(`Too many redirects (max ${maxRedirects}) from ${urlHost(url)}`)))
          return
        }
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') return safeReject(unlinkErr)
          const redirectUrl = new URL(response.headers.location, url).href
          handedOff = true
          downloadFileOnce(redirectUrl, dest, { ...opts, _redirectCount: _redirectCount + 1 })
            .then(safeResolve)
            .catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        const err = Object.assign(
          new Error(`Download failed: HTTP ${response.statusCode} from ${urlHost(url)}`),
          { statusCode: response.statusCode }
        )
        file.destroy()
        cleanupAndReject(err)
        return
      }

      let idleTimer = null
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          response.destroy(Object.assign(
            new Error(`Response idle timeout after ${idleTimeoutMs}ms from ${urlHost(url)}`),
            { code: 'ETIMEDOUT' }
          ))
        }, idleTimeoutMs)
      }
      resetIdle()
      response.on('data', resetIdle)
      response.on('error', (err) => { if (idleTimer) clearTimeout(idleTimer); file.destroy(); cleanupAndReject(err) })

      response.pipe(file)
      file.on('close', () => { if (idleTimer) clearTimeout(idleTimer); safeResolve() })
    })

    req.on('error', err => { clearTimeout(reqTimer); file.destroy(); cleanupAndReject(err) })
    req.end()
  })
}

async function downloadFileWithRetries (url, dest, opts = {}) {
  const { retries = 3, minBytes = 1, ...downloadOpts } = opts
  const partPath = dest + '.part'

  for (let attempt = 0; attempt <= retries; attempt++) {
    const host = urlHost(url)
    try {
      await downloadFileOnce(url, partPath, downloadOpts)

      const stat = fs.statSync(partPath)
      if (stat.size < minBytes) {
        fs.unlinkSync(partPath)
        throw Object.assign(new Error(`Downloaded file is empty from ${host}`), { code: 'ESIZE' })
      }

      fs.renameSync(partPath, dest)
      return
    } catch (err) {
      try { fs.unlinkSync(partPath) } catch (_) {}

      const attemptsLeft = retries - attempt
      if (!isTransientError(err) || attemptsLeft === 0) {
        console.error(`[download] Failed after ${attempt + 1} attempt(s) from ${host}: ${err.code || err.message}`)
        throw err
      }

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30_000)
      console.log(`[download] Attempt ${attempt + 1}/${retries + 1} failed (${err.code || err.statusCode}) from ${host}, retrying in ${Math.round(delay)}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

// Ensures a model exists under test/integration/model/, downloading it if missing.
// Returns the absolute path to the model file.
async function ensureModel ({ name, url }) {
  const modelDir = path.resolve(__dirname, 'model')
  const modelPath = path.join(modelDir, name)

  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath)
    if (stat.size > 0) return modelPath
    console.log(`[download] Removing zero-byte cached file: ${name}`)
    fs.unlinkSync(modelPath)
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`[download] Downloading ${name}...`)
  await downloadFileWithRetries(url, modelPath, { minBytes: 1024 })

  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${name} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  return modelPath
}

module.exports = { ensureModel }
