'use strict'

// Minimal test-model downloader for the model-fit integration test. Fetches
// a small public GGUF into test/model/ (cached in CI by the cache-models
// action) so the projection path runs against a real model on every platform.
// Download logic mirrors the proven helper in embed-llamacpp / llm-llamacpp
// (redirect + retry handling for HuggingFace CDN hops).

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')

const TRANSIENT_ERROR_CODES = new Set([
  'EAI_NODATA', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ESIZE'
])

// A tiny (~1MB) llama-architecture GGUF. Public, no auth — ideal for a fast
// all-platform fit projection. Override with FIT_MODEL_PATH to point the test
// at a real model locally.
const DEFAULT_MODEL = {
  modelName: 'stories260K.gguf',
  downloadUrl: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'
}

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

async function downloadFileOnce (url, dest, opts = {}) {
  const { timeoutMs = 30_000, idleTimeoutMs = 30_000, maxRedirects = 10, _redirectCount = 0 } = opts
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => { if (!resolved) { resolved = true; resolve() } }
    const safeReject = (err) => { if (!resolved) { resolved = true; reject(err) } }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => { file.destroy(); fs.unlink(dest, () => safeReject(err)) })

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
        fs.unlink(dest, () => safeReject(err))
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
      response.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer)
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })

      response.pipe(file)
      file.on('close', () => { if (idleTimer) clearTimeout(idleTimer); safeResolve() })
    })

    req.on('error', err => { clearTimeout(reqTimer); file.destroy(); fs.unlink(dest, () => safeReject(err)) })
    req.end()
  })
}

async function downloadFileWithRetries (urls, dest, opts = {}) {
  const { retries = 3, minBytes = 1, ...downloadOpts } = opts
  const urlList = Array.isArray(urls) ? urls : [urls]
  const partPath = dest + '.part'

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = urlList[attempt % urlList.length]
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

/**
 * Ensures the test GGUF exists (downloading it once, cached in CI) and returns
 * its absolute path. Honours FIT_MODEL_PATH as an override for local runs.
 * @returns {Promise<string>} absolute path to a GGUF file
 */
async function ensureModelPath ({ modelName, downloadUrl } = DEFAULT_MODEL) {
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 0) {
    return modelPath
  }
  if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath)

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`[download] Downloading test model: ${modelName}...`)
  await downloadFileWithRetries(downloadUrl, modelPath)
  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stat.size / 1024 / 1024).toFixed(2)}MB`)
  return modelPath
}

module.exports = {
  DEFAULT_MODEL,
  downloadFile: downloadFileWithRetries,
  ensureModelPath
}
