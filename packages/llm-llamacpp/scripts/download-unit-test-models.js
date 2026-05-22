#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')

const PKG_ROOT = path.resolve(__dirname, '..')
const MODEL_DIR = path.join(PKG_ROOT, 'models', 'unit-test')

const TRANSIENT_ERROR_CODES = new Set([
  'EAI_NODATA', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ESIZE'
])

function log (message) {
  console.log(`[download-unit-test-models] ${message}`)
}

function formatSize (bytes) {
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`
}

function urlHost (url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function isTransientError (err) {
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true
  if (err.statusCode) {
    const status = err.statusCode
    return status === 408 || status === 429 || status >= 500
  }
  return false
}

function requestHeaders () {
  const headers = {}
  const token = process.env.HF_TOKEN
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

function downloadFileOnce (url, dest, opts = {}) {
  const {
    timeoutMs = 30_000,
    idleTimeoutMs = 30_000,
    maxRedirects = 10,
    redirectCount = 0
  } = opts

  return new Promise((resolve, reject) => {
    let settled = false
    let handedOff = false

    const safeResolve = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const safeReject = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const cleanupAndReject = (err) => {
      if (settled || handedOff) {
        if (!settled) safeReject(err)
        return
      }
      fs.unlink(dest, () => safeReject(err))
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      cleanupAndReject(err)
    })

    const reqTimer = setTimeout(() => {
      req.destroy(Object.assign(
        new Error(`Request timeout after ${timeoutMs}ms from ${urlHost(url)}`),
        { code: 'ETIMEDOUT' }
      ))
    }, timeoutMs)

    const req = https.request(url, { headers: requestHeaders() }, (response) => {
      clearTimeout(reqTimer)

      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        if (redirectCount >= maxRedirects) {
          fs.unlink(dest, () => {
            safeReject(new Error(`Too many redirects (max ${maxRedirects}) from ${urlHost(url)}`))
          })
          return
        }
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            safeReject(unlinkErr)
            return
          }
          const redirectUrl = new URL(response.headers.location, url).href
          handedOff = true
          downloadFileOnce(redirectUrl, dest, {
            timeoutMs,
            idleTimeoutMs,
            maxRedirects,
            redirectCount: redirectCount + 1
          }).then(safeResolve).catch(safeReject)
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
      response.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer)
        file.destroy()
        cleanupAndReject(err)
      })

      response.pipe(file)
      file.on('close', () => {
        if (idleTimer) clearTimeout(idleTimer)
        safeResolve()
      })
    })

    req.on('error', (err) => {
      clearTimeout(reqTimer)
      file.destroy()
      cleanupAndReject(err)
    })
    req.end()
  })
}

async function downloadFileWithRetries (url, dest, opts = {}) {
  const { retries = 3, minBytes = 1, ...downloadOpts } = opts
  const partPath = `${dest}.part`

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
      try {
        fs.unlinkSync(partPath)
      } catch (_) {}

      const attemptsLeft = retries - attempt
      if (!isTransientError(err) || attemptsLeft === 0) {
        throw err
      }

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30_000)
      log(`retry ${attempt + 1}/${retries + 1} for ${path.basename(dest)} (${err.code || err.message}) in ${Math.round(delay)}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

async function downloadFile (url, dest) {
  const name = path.basename(dest)

  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest)
    if (stat.size > 0) {
      log(`skip (exists): ${name} (${formatSize(stat.size)})`)
      return
    }
    log(`remove empty file: ${name}`)
    fs.unlinkSync(dest)
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  log(`download: ${name}`)

  try {
    await downloadFileWithRetries(url, dest)
  } catch (err) {
    try {
      fs.unlinkSync(dest)
    } catch (_) {}
    throw new Error(`failed to download ${name} from ${url}: ${err.message}`)
  }

  const stat = fs.statSync(dest)
  if (stat.size <= 0) {
    fs.unlinkSync(dest)
    throw new Error(`${name} is empty after download`)
  }
  log(`done: ${name} (${formatSize(stat.size)})`)
}

async function downloadShardedRepo (baseUrl, files) {
  for (const file of files) {
    await downloadFile(`${baseUrl}/${file}`, path.join(MODEL_DIR, file))
  }
}

// Single-file models. Each entry's `scope` controls when it is downloaded:
//   'ci'       -> always downloaded (mirrors .github/workflows/cpp-tests-llm.yml)
//   'optional' -> only downloaded for full local runs; the matching unit tests
//                 use OnMissing::Skip, so CI deliberately skips them.
const SINGLE_FILE_MANIFEST = [
  {
    scope: 'ci',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
    dest: 'Llama-3.2-1B-Instruct-Q4_0.gguf'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    dest: 'SmolVLM-500M-Instruct-Q8_0.gguf'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    dest: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf',
    dest: 'Qwen3-0.6B-Q8_0.gguf'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0/resolve/main/bitnet_b1_58-large-TQ2_0.gguf',
    dest: 'bitnet_b1_58-large-TQ2_0.gguf'
  }
]

const SHARDED_REPOS = [
  {
    scope: 'ci',
    label: 'Qwen3-0.6B-UD-IQ1_S (3 shards)',
    baseUrl: 'https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded/resolve/main',
    files: [
      'Qwen3-0.6B-UD-IQ1_S.tensors.txt',
      'Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf',
      'Qwen3-0.6B-UD-IQ1_S-00002-of-00003.gguf',
      'Qwen3-0.6B-UD-IQ1_S-00003-of-00003.gguf'
    ]
  },
  {
    scope: 'ci',
    label: 'bitnet_b1_58-large-TQ2_0 (8 shards)',
    baseUrl: 'https://huggingface.co/jmb95/bitnet_b1_58-large-TQ2_0-sharded/resolve/main',
    files: [
      'bitnet_b1_58-large-TQ2_0.tensors.txt',
      'bitnet_b1_58-large-TQ2_0-00001-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00002-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00003-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00004-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00005-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00006-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00007-of-00008.gguf',
      'bitnet_b1_58-large-TQ2_0-00008-of-00008.gguf'
    ]
  },
  {
    // Enables ModelFullLoadingTest.{LargeSharded,StreamingLargeShards}_LoadsSuccessfully,
    // which gtest-skip on CI because the shards aren't fetched there.
    scope: 'optional',
    label: 'Llama-3.2-1B-Instruct-Q4_0 (8 shards)',
    baseUrl: 'https://huggingface.co/jmb95/Llama-3.2-1B-Instruct-Q4_0-sharded/resolve/main',
    files: [
      'Llama-3.2-1B-Instruct-Q4_0.tensors.txt',
      'Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00002-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00003-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00004-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00005-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00006-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00007-of-00008.gguf',
      'Llama-3.2-1B-Instruct-Q4_0-00008-of-00008.gguf'
    ]
  }
]

function shouldInclude (scope, options) {
  if (options.ciOnly) return scope === 'ci'
  return true
}

async function ensureUnitTestModels (options = {}) {
  const opts = { ciOnly: options.ciOnly === true }

  fs.mkdirSync(MODEL_DIR, { recursive: true })
  log(`target directory: ${MODEL_DIR}`)
  log(opts.ciOnly
    ? 'mode: --ci (matches .github/workflows/cpp-tests-llm.yml)'
    : 'mode: full (includes optional fixtures CI skips)')

  for (const entry of SINGLE_FILE_MANIFEST) {
    if (!shouldInclude(entry.scope, opts)) continue
    await downloadFile(entry.url, path.join(MODEL_DIR, entry.dest))
  }

  for (const repo of SHARDED_REPOS) {
    if (!shouldInclude(repo.scope, opts)) continue
    log(`sharded: ${repo.label}`)
    await downloadShardedRepo(repo.baseUrl, repo.files)
  }

  log(opts.ciOnly
    ? `CI manifest ready under ${MODEL_DIR}`
    : `all unit-test models ready under ${MODEL_DIR}`)
}

async function main () {
  const ciOnly = process.argv.includes('--ci')
  await ensureUnitTestModels({ ciOnly })
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}

module.exports = {
  MODEL_DIR,
  ensureUnitTestModels
}
