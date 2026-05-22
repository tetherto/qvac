#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')

const PKG_ROOT = path.resolve(__dirname, '..')
const MODEL_DIR = path.join(PKG_ROOT, 'models', 'unit-test')

// Owned agent so we can destroy idle keep-alive sockets after the run; using
// the global agent keeps a TLS socket alive for ~30s and prevents the process
// from exiting cleanly when this script (or a caller) finishes.
const httpsAgent = new https.Agent({ keepAlive: true })

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

    // reqTimer is assigned after req is created so the timer's closure can
    // reference req safely; declared as let with no initializer so the
    // response/error closures below can also reference it without TDZ.
    let reqTimer // eslint-disable-line prefer-const

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      cleanupAndReject(err)
    })

    const req = https.request(url, { headers: requestHeaders(), agent: httpsAgent }, (response) => {
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

    reqTimer = setTimeout(() => {
      req.destroy(Object.assign(
        new Error(`Request timeout after ${timeoutMs}ms from ${urlHost(url)}`),
        { code: 'ETIMEDOUT' }
      ))
    }, timeoutMs)

    req.end()
  })
}

function removeIfExists (filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function sha256OfFile (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifySha256 (filePath, expected) {
  if (!expected) return
  const actual = await sha256OfFile(filePath)
  if (actual !== expected) {
    throw Object.assign(
      new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`),
      { code: 'ECHECKSUM' }
    )
  }
}

async function downloadFileWithRetries (url, dest, opts = {}) {
  const { retries = 3, minBytes = 1, sha256, ...downloadOpts } = opts
  const partPath = `${dest}.part`

  for (let attempt = 0; attempt <= retries; attempt++) {
    const host = urlHost(url)
    try {
      await downloadFileOnce(url, partPath, downloadOpts)

      const stat = fs.statSync(partPath)
      if (stat.size < minBytes) {
        removeIfExists(partPath)
        throw Object.assign(new Error(`Downloaded file is empty from ${host}`), { code: 'ESIZE' })
      }

      await verifySha256(partPath, sha256)

      fs.renameSync(partPath, dest)
      return
    } catch (err) {
      removeIfExists(partPath)

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

async function downloadFile (url, dest, opts = {}) {
  const name = path.basename(dest)
  const { sha256 } = opts

  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest)
    if (stat.size > 0) {
      if (sha256) {
        try {
          await verifySha256(dest, sha256)
          log(`skip (exists, sha256 ok): ${name} (${formatSize(stat.size)})`)
          return
        } catch (err) {
          log(`re-download (${err.code}): ${name}`)
          removeIfExists(dest)
        }
      } else {
        log(`skip (exists): ${name} (${formatSize(stat.size)})`)
        return
      }
    } else {
      log(`remove empty file: ${name}`)
      fs.unlinkSync(dest)
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  log(`download: ${name}`)

  try {
    await downloadFileWithRetries(url, dest, { sha256 })
  } catch (err) {
    removeIfExists(dest)
    throw new Error(`failed to download ${name} from ${url}: ${err.message}`)
  }

  const stat = fs.statSync(dest)
  if (stat.size <= 0) {
    removeIfExists(dest)
    throw new Error(`${name} is empty after download`)
  }
  log(`done: ${name} (${formatSize(stat.size)})`)
}

async function downloadShardedRepo (baseUrl, files, sha256Map = {}) {
  for (const file of files) {
    await downloadFile(`${baseUrl}/${file}`, path.join(MODEL_DIR, file), {
      sha256: sha256Map[file]
    })
  }
}

// Single-file models. Each entry's `scope` controls when it is downloaded:
//   'ci'       -> always downloaded (mirrors .github/workflows/cpp-tests-llm.yml)
//   'optional' -> only downloaded for full local runs; the matching unit tests
//                 use OnMissing::Skip, so CI deliberately skips them.
// SHA256 digests are computed from known-good local fixtures; downloads that
// do not match are retried as transient and ultimately fail the run.
const SINGLE_FILE_MANIFEST = [
  {
    scope: 'ci',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
    dest: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    sha256: 'fa0390e7c043f89ae1847bd6682d748041a99d4ef3de0e0b27d33b6af97a8be8'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    dest: 'SmolVLM-500M-Instruct-Q8_0.gguf',
    sha256: '6f67b8036b2469fcd71728702720c6b51aebd759b78137a8120733b4d66438bc'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    dest: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf',
    sha256: '921dc7e259f308e5b027111fa185efcbf33db13f6e35749ddf7f5cdb60ef520b'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf',
    dest: 'Qwen3-0.6B-Q8_0.gguf',
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031'
  },
  {
    scope: 'ci',
    url: 'https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0/resolve/main/bitnet_b1_58-large-TQ2_0.gguf',
    dest: 'bitnet_b1_58-large-TQ2_0.gguf',
    sha256: '281aafb18a9f4a3124c10a1d8683e2296f0cfe8a2944da0a5667d17488a951bb'
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
    ],
    sha256: {
      'Qwen3-0.6B-UD-IQ1_S.tensors.txt': 'c10b950a18ec75d3ee61b55ed1ba5b4c3ff3d7afd726651b813d48165bd5847a',
      'Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf': '27a0f5d92fffa1b1907218f62d7a82fa1a0bf5adce4975c9b7f4ccc0f34e8c88',
      'Qwen3-0.6B-UD-IQ1_S-00002-of-00003.gguf': '36c7926642ead53c74ba07d15c9d35d2e9390db575f60d25cb92565c5b9f2b2c',
      'Qwen3-0.6B-UD-IQ1_S-00003-of-00003.gguf': 'ddc1be0331c403269b5eced1806c1a3f4a952f0d70b44e58da83bc846b5c8c5c'
    }
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
    ],
    sha256: {
      'bitnet_b1_58-large-TQ2_0.tensors.txt': '6d7950adc98635bb67a198abe72b9c511643ade55e8016ec413237d99210fb4e',
      'bitnet_b1_58-large-TQ2_0-00001-of-00008.gguf': 'fb913ff5d3df8508f312f7ea1429de8ae1ed0efb907809540225fb0fa2206af6',
      'bitnet_b1_58-large-TQ2_0-00002-of-00008.gguf': 'aed7d7d5d1546cf2e1bb3c449ec9bfd0f91b6ce5875582f3b46ee16de0d827d3',
      'bitnet_b1_58-large-TQ2_0-00003-of-00008.gguf': '794504966f0ded57fa4b6320b496c6276cb92ca61e169f5a9c35d0cd101cac33',
      'bitnet_b1_58-large-TQ2_0-00004-of-00008.gguf': '37d01af5297d0150a02aa90fd8de444ed7cc17d0d96d13a6bf2184fb45ef5b5f',
      'bitnet_b1_58-large-TQ2_0-00005-of-00008.gguf': '5c76c66c50e5dd28a7372d84bb68feb591ced2a4e193e3ef27307edeffa46a27',
      'bitnet_b1_58-large-TQ2_0-00006-of-00008.gguf': '2bacfafd6571366d1f5781ea16ae4e282453fef8df23fef68e87f070551bad61',
      'bitnet_b1_58-large-TQ2_0-00007-of-00008.gguf': '0c98501dc019105b4e5d30d07495e7f560e9155a1310222b78009fb7d1173520',
      'bitnet_b1_58-large-TQ2_0-00008-of-00008.gguf': 'b7db415236997cce915244abc6163eb313e40476025afd1f495d0880ee69a95b'
    }
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
    ],
    sha256: {
      'Llama-3.2-1B-Instruct-Q4_0.tensors.txt': '94d891c22bca7700d422a3974b6aaa8095a4b2f132a53c89e7312b8435412cbf',
      'Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf': 'fafc6166dc5e7a9791b053cda2e71924c037b16f09fa41d69383cedd37cd91d8',
      'Llama-3.2-1B-Instruct-Q4_0-00002-of-00008.gguf': 'a74db7a0871a97b2f82bff0e8bcd675b47f1b71b2604ae532d53e830d8929128',
      'Llama-3.2-1B-Instruct-Q4_0-00003-of-00008.gguf': 'ef6bf88818090ae955c9701ebd1c20e182abf52bbf2b57c06aeebaf98db9b764',
      'Llama-3.2-1B-Instruct-Q4_0-00004-of-00008.gguf': '8370dbdbbf6ad993971a1270e34b6648b6a238b2e177e8c2361a5e1976bd803e',
      'Llama-3.2-1B-Instruct-Q4_0-00005-of-00008.gguf': '924cae739e6fc9bcf613cfcd92ffd6b8e766cf3fc90a62a8cd49a02ccd30383b',
      'Llama-3.2-1B-Instruct-Q4_0-00006-of-00008.gguf': '4eb85c7c807d593fd9e91dad6fb7b18c715ddfa667a3b47cee1176b3331921f0',
      'Llama-3.2-1B-Instruct-Q4_0-00007-of-00008.gguf': 'ad86b62f5270613771fb5c3dd69e9f94103beb4b74f8d63687f7f0578b728788',
      'Llama-3.2-1B-Instruct-Q4_0-00008-of-00008.gguf': '51ca922125a8a543daea7fb30a71e6d683e025148ce6a4c335accbdec0f7a2ad'
    }
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

  try {
    for (const entry of SINGLE_FILE_MANIFEST) {
      if (!shouldInclude(entry.scope, opts)) continue
      await downloadFile(entry.url, path.join(MODEL_DIR, entry.dest), {
        sha256: entry.sha256
      })
    }

    for (const repo of SHARDED_REPOS) {
      if (!shouldInclude(repo.scope, opts)) continue
      log(`sharded: ${repo.label}`)
      await downloadShardedRepo(repo.baseUrl, repo.files, repo.sha256)
    }

    log(opts.ciOnly
      ? `CI manifest ready under ${MODEL_DIR}`
      : `all unit-test models ready under ${MODEL_DIR}`)
  } finally {
    // Release idle keep-alive sockets so callers can exit promptly.
    httpsAgent.destroy()
  }
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
