'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

/** Returns true if file exists and is valid JSON; false if missing, wrong size, or invalid. */
function isValidJsonCache (filepath) {
  try {
    if (!fs.existsSync(filepath)) return false
    const stats = fs.statSync(filepath)
    // 1024 bytes is the binary placeholder size - treat as invalid cache for JSON
    if (stats.size === 1024) return false
    if (stats.size < 10) return false
    const raw = fs.readFileSync(filepath, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
  } catch (e) {
    return false
  }
}

/**
 * Mobile-friendly HTTPS download using bare-https.
 * Handles redirects and writes directly to file.
 */
async function downloadWithHttp (url, filepath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    const https = require('bare-https')
    const { URL } = require('bare-url')

    const parsedUrl = new URL(url)

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; bare-download/1.0)'
      }
    }

    console.log(` [HTTPS] Requesting: ${parsedUrl.hostname}${parsedUrl.pathname}`)

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'))
          return
        }
        const location = res.headers.location
        let redirectUrl
        if (location.startsWith('http://') || location.startsWith('https://')) {
          redirectUrl = location
        } else if (location.startsWith('/')) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${location}`
        } else {
          const basePath = parsedUrl.pathname.substring(0, parsedUrl.pathname.lastIndexOf('/') + 1)
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${basePath}${location}`
        }
        console.log(` [HTTPS] Redirecting to: ${redirectUrl}`)
        downloadWithHttp(redirectUrl, filepath, maxRedirects - 1).then(resolve).catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`))
        return
      }

      const dir = path.dirname(filepath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      const writeStream = fs.createWriteStream(filepath)
      let downloadedBytes = 0
      const contentLength = parseInt(res.headers['content-length'] || '0', 10)

      res.on('data', (chunk) => {
        writeStream.write(chunk)
        downloadedBytes += chunk.length
        if (contentLength > 0 && downloadedBytes % (1024 * 1024) < chunk.length) {
          const percent = ((downloadedBytes / contentLength) * 100).toFixed(1)
          console.log(` [HTTPS] Progress: ${percent}% (${downloadedBytes} / ${contentLength} bytes)`)
        }
      })

      res.on('end', () => {
        writeStream.end()
        writeStream.on('finish', () => resolve({ success: true, path: filepath }))
        writeStream.on('error', reject)
      })

      res.on('error', reject)
    })

    req.on('error', reject)
    req.end()
  })
}

function getFileSizeFromUrl (url) {
  try {
    const { spawnSync } = require('bare-subprocess')
    const result = spawnSync('curl', [
      '-I', '-L', url,
      '--fail', '--silent', '--show-error',
      '--connect-timeout', '10',
      '--max-time', '30'
    ], { stdio: ['inherit', 'pipe', 'pipe'] })

    if (result.status === 0 && result.stdout) {
      const output = result.stdout.toString()
      const match = output.match(/content-length:\s*(\d+)/i)
      if (match) return parseInt(match[1], 10)
    }
  } catch (e) {
    console.log(` Warning: Could not get file size from URL: ${e.message}`)
  }
  return null
}

async function ensureFileDownloaded (url, filepath) {
  const isJson = filepath.endsWith('.json')
  const dir = path.dirname(filepath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const expectedSize = isMobile ? null : getFileSizeFromUrl(url)
  const minSize = expectedSize ? Math.floor(expectedSize * 0.9) : (isJson ? 100 : 1000000)

  if (fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath)
    if (stats.size >= minSize) {
      if (isJson && !isValidJsonCache(filepath)) {
        console.log(` Cached JSON invalid or placeholder (${stats.size} bytes), re-downloading...`)
        fs.unlinkSync(filepath)
      } else {
        console.log(` ✓ Using cached model: ${path.basename(filepath)} (${stats.size} bytes)`)
        return { success: true, path: filepath, isReal: true }
      }
    } else {
      console.log(` Cached file too small (${stats.size} bytes), re-downloading...`)
      fs.unlinkSync(filepath)
    }
  }

  console.log(` Downloading: ${path.basename(filepath)}...`)
  if (expectedSize) console.log(` Expected size: ${expectedSize} bytes`)

  if (isMobile) {
    try {
      const result = await downloadWithHttp(url, filepath)
      if (result.success && fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath)
        if (stats.size >= minSize) {
          if (isJson && !isValidJsonCache(filepath)) {
            console.log(' Downloaded file is not valid JSON, discarding')
            fs.unlinkSync(filepath)
          } else {
            console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
            return { success: true, path: filepath, isReal: true }
          }
        } else {
          console.log(` Downloaded file too small: ${stats.size} bytes (expected >${minSize})`)
        }
      }
    } catch (e) {
      console.log(` HTTP download error: ${e.message}`)
    }
  } else {
    try {
      const { spawnSync } = require('bare-subprocess')
      if (isJson) {
        const result = spawnSync('curl', [
          '-L', url,
          '--fail', '--silent', '--show-error',
          '--connect-timeout', '30',
          '--max-time', '300'
        ], { stdio: ['inherit', 'pipe', 'pipe'] })

        if (result.status === 0 && result.stdout) {
          fs.writeFileSync(filepath, result.stdout)
          const stats = fs.statSync(filepath)
          if (stats.size >= minSize && isValidJsonCache(filepath)) {
            console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
            return { success: true, path: filepath, isReal: true }
          }
          fs.unlinkSync(filepath)
        } else {
          console.log(` Download failed with exit code: ${result.status}`)
        }
      } else {
        const result = spawnSync('curl', [
          '-L', '-o', filepath, url,
          '--fail', '--silent', '--show-error',
          '--connect-timeout', '30',
          '--max-time', '1800'
        ], { stdio: ['inherit', 'inherit', 'pipe'] })

        if (result.status === 0 && fs.existsSync(filepath)) {
          const stats = fs.statSync(filepath)
          if (stats.size >= minSize) {
            console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
            return { success: true, path: filepath, isReal: true }
          }
          console.log(` Downloaded file too small: ${stats.size} bytes (expected >${minSize})`)
        } else {
          console.log(` Download failed with exit code: ${result.status}`)
        }
      }
    } catch (e) {
      console.log(` Download error: ${e.message}`)
    }
  }

  // Only create placeholder for binary files; JSON placeholders confuse the size check.
  if (!isJson) {
    console.log(' Creating placeholder model for error testing')
    fs.writeFileSync(filepath, Buffer.alloc(1024))
  }
  return { success: false, path: filepath, isReal: false }
}

// QVAC model registry fetch.  Used as a fallback by the
// ensure{Chatterbox,Supertonic}* helpers below when none of the
// candidate filesystem paths already has the GGUF.  Mirrors the
// pattern used by qvac/translation-nmtcpp/lib/indictrans-model-fetcher.js:
// lazy-require `@qvac/registry-client` (it's a devDependency that's
// only present in the CI / test image, not in the published addon),
// fall through to a soft failure when the client can't be loaded so
// the existing "skip integration test" behaviour is preserved on
// environments without registry access (no network, no peers, etc.).
//
// `path` here is the registry path string stored under each
// {CHATTERBOX,SUPERTONIC}*_GGUFS entry's `registryPath` field; `source`
// is the matching `registrySource` (today always "s3", mirroring the
// `s3:///...` URL prefix used in registry-server/data/models.prod.json).
async function downloadFromRegistry (registryPath, registrySource, destPath, minSize, maxSize) {
  let QVACRegistryClient
  try {
    ({ QVACRegistryClient } = require('@qvac/registry-client'))
  } catch (err) {
    console.log(' Registry client (@qvac/registry-client) not installed; ' +
      'skipping registry fetch.  Install as a devDependency to enable.')
    return false
  }

  const destDir = path.dirname(destPath)
  if (!fs.existsSync(destDir)) {
    try {
      fs.mkdirSync(destDir, { recursive: true })
    } catch (err) {
      console.log(` Could not create ${destDir} for registry download: ${err.message}`)
      return false
    }
  }

  console.log(` Fetching ${path.basename(destPath)} from QVAC registry...`)
  console.log(`   path:   ${registryPath}`)
  console.log(`   source: ${registrySource}`)

  let client
  try {
    client = new QVACRegistryClient()
    await client.ready()
    const result = await client.downloadModel(registryPath, registrySource, {
      outputFile: destPath
    })
    if (result && result.artifact && result.artifact.path) {
      const stats = fs.statSync(result.artifact.path)
      if (stats.size < minSize) {
        console.log(` Registry download too small: ${stats.size} bytes (expected >=${minSize})`)
        try { fs.unlinkSync(destPath) } catch (_e) {}
      } else if (maxSize && stats.size > maxSize) {
        // Should be impossible (the registry served a file outside the
        // declared band) but assert so a future model swap that
        // accidentally points at the wrong quant level surfaces here
        // instead of silently triggering an OOM on-device.
        console.log(` Registry download too large: ${stats.size} bytes (expected <=${maxSize}). ` +
          'Did the registry path flip to a different quantisation tier?')
        try { fs.unlinkSync(destPath) } catch (_e) {}
      } else {
        console.log(` ✓ Registry download: ${path.basename(destPath)} (${stats.size} bytes)`)
        return true
      }
    } else {
      console.log(' Registry download returned no artifact path')
    }
  } catch (err) {
    console.log(` Registry download failed: ${err && err.message ? err.message : String(err)}`)
    try { fs.unlinkSync(destPath) } catch (_e) {}
  } finally {
    if (client) {
      try { await client.close() } catch (_e) {}
    }
  }

  return false
}

// Attempt a registry fetch for every entry in `ggufs` into `targetDir`.
// Returns true iff every file ended up present at the expected size.
// Used by the four `ensure*` helpers below as the fallback path when
// no local candidate directory already had the GGUFs.
async function tryFetchGgufsFromRegistry (ggufs, targetDir) {
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
  } catch (err) {
    console.log(` Could not create target dir ${targetDir}: ${err.message}`)
    return false
  }

  let allOk = true
  for (const f of ggufs) {
    const dest = path.join(targetDir, f.name)
    if (fs.existsSync(dest)) {
      try {
        const stats = fs.statSync(dest)
        const inBand = stats.size >= f.minSize &&
          (!f.maxSize || stats.size <= f.maxSize)
        if (inBand) {
          console.log(` ✓ Already present at expected size: ${f.name} (${stats.size} bytes)`)
          continue
        }
        if (stats.size < f.minSize) {
          console.log(` Re-fetching ${f.name} (cached ${stats.size} bytes < ${f.minSize})`)
        } else {
          // Stale cache from a previous quantisation tier (e.g. an f16
          // file lingering after the registry source flipped to q4_0).
          // Drop it and re-fetch the smaller variant.
          console.log(` Re-fetching ${f.name} (cached ${stats.size} bytes > ${f.maxSize}; ` +
            'likely a stale cache from a different quantisation tier)')
        }
        try { fs.unlinkSync(dest) } catch (_e) {}
      } catch (_e) { /* fall through to download */ }
    }
    if (!f.registryPath || !f.registrySource) {
      console.log(` ${f.name} has no registryPath/registrySource; cannot fetch.`)
      allOk = false
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const ok = await downloadFromRegistry(
      f.registryPath, f.registrySource, dest, f.minSize, f.maxSize)
    if (!ok) {
      allOk = false
      // Keep going so the user sees errors for every missing file in
      // one pass rather than needing N reruns to discover the next
      // failure.
    }
  }
  return allOk
}

// Whisper GGML (for the transcription-WER integration check).
const WHISPER_MODELS = {
  'ggml-small.bin': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', minSize: 460000000 },
  'ggml-medium.bin': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin', minSize: 1400000000 }
}

async function ensureWhisperModel (targetPath = null) {
  if (!targetPath) {
    targetPath = path.join(getBaseDir(), 'models', 'whisper', 'ggml-medium.bin')
  }
  const modelFile = path.basename(targetPath)
  const modelInfo = WHISPER_MODELS[modelFile] || WHISPER_MODELS['ggml-medium.bin']

  if (fs.existsSync(targetPath)) {
    const stats = fs.statSync(targetPath)
    if (stats.size > modelInfo.minSize) {
      console.log(` ✓ Whisper model already exists (${stats.size} bytes)`)
      return { success: true, path: targetPath }
    }
    console.log(` Cached Whisper model too small (${stats.size} bytes), re-downloading...`)
    fs.unlinkSync(targetPath)
  }

  const dir = path.dirname(targetPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const result = await ensureFileDownloaded(modelInfo.url, targetPath)
  return { success: result.success, path: targetPath }
}

// Registry metadata for the QVAC model registry fetch fallback (see
// `downloadFromRegistry()` below + `models.prod.json` under packages/
// registry-server/data/).  Tables live next to this file (rather than
// under scripts/) so the mobile test framework's "copy test/ into
// backend/" packing path keeps them resolvable alongside the
// downloader; the desktop CI `npm run download-models` step imports
// the same module via a relative path.
const {
  CHATTERBOX_GGUFS,
  CHATTERBOX_MTL_GGUFS,
  SUPERTONIC_GGUFS,
  SUPERTONIC_MTL_GGUFS
} = require('./registry-models')

/** Directories searched on Android (in order) when the caller-supplied
 *  `targetDir` doesn't already have the GGUFs.  All of these are
 *  `adb push`-friendly locations on a standard (non-rooted) device. */
const ANDROID_CANDIDATE_DIRS = [
  '/sdcard/qvac-tts-ggml/models',
  '/storage/emulated/0/qvac-tts-ggml/models',
  '/data/local/tmp/qvac-tts-ggml/models'
]

/** Optional `TTS_GGML_LOCAL_MODELS_DIR` env override + a desktop dev
 *  fallback that points at chatterbox.cpp's converter output dir.
 *  Both are appended to the candidate list AFTER the caller-supplied
 *  `targetDir` so production runs remain deterministic. */
function desktopFallbackDirs () {
  const out = []
  const env = (process && process.env) ? process.env.TTS_GGML_LOCAL_MODELS_DIR : null
  if (env) out.push(env)
  out.push('./models')
  out.push('../../../chatterbox.cpp/models')
  return out
}

function buildCandidateDirs (requestedDir) {
  const candidateDirs = [requestedDir]
  const extra = (isMobile && platform === 'android')
    ? ANDROID_CANDIDATE_DIRS
    : desktopFallbackDirs()
  for (const d of extra) {
    if (!candidateDirs.includes(d)) candidateDirs.push(d)
  }
  return candidateDirs
}

/**
 * Returns true iff `dir` contains every file in `ggufs` at the
 * expected size band.  `maxSize` is optional; when provided, a cached
 * file larger than that band is rejected so the next pass re-fetches
 * from the registry (used to flush a stale f16 cache after the
 * registry source flipped to a q4_0 variant — same name on disk, much
 * smaller payload).
 */
function hasAllGgufsIn (dir, ggufs) {
  for (const f of ggufs) {
    const p = path.join(dir, f.name)
    if (!fs.existsSync(p)) return false
    try {
      const stats = fs.statSync(p)
      if (stats.size < f.minSize) return false
      if (f.maxSize && stats.size > f.maxSize) return false
    } catch (e) {
      return false
    }
  }
  return true
}

function findLocalCandidate (candidateDirs, ggufs) {
  for (const dir of candidateDirs) {
    if (hasAllGgufsIn(dir, ggufs)) return dir
  }
  return null
}

function buildResultsMap (ggufs, dir, cached) {
  const results = {}
  for (const f of ggufs) {
    results[f.name] = { success: true, path: path.join(dir, f.name), cached }
  }
  return results
}

function logMissingGgufs (ggufs, dir) {
  for (const f of ggufs) {
    const p = path.join(dir, f.name)
    const exists = fs.existsSync(p)
    const size = exists ? fs.statSync(p).size : 0
    console.log(` ✗ ${f.name} ${exists ? `too small (${size} bytes, expected ≥ ${f.minSize})` : `missing at ${p}`}`)
  }
}

function buildMissingError (label, ggufs, requestedDir, candidateDirs) {
  const names = ggufs.map(f => f.name).join(', ')
  const where = candidateDirs.join(', ')
  return new Error(
    `${label} GGUFs unavailable. Tried local dirs [${where}] and the QVAC ` +
    `registry; none returned valid files for: ${names}. ` +
    'Set TTS_GGML_LOCAL_MODELS_DIR to a dir holding the GGUFs, or run ' +
    `\`npm run download-models\` from packages/tts-ggml. Last requested dir: ${requestedDir}.`
  )
}

/**
 * Locate every GGUF in `ggufs` under one of the candidate dirs, or
 * fall through to a QVAC registry fetch into `requestedDir`.  Throws
 * if neither path succeeds — there is no silent skip.
 *
 * Returns `{ targetDir, cached, results }` where `cached` is true iff
 * the win came from local discovery (no registry traffic).
 */
async function locateOrFetchGgufs (label, ggufs, requestedDir) {
  console.log(`Ensuring ${label} GGUFs (requested dir: ${requestedDir})...`)

  const candidateDirs = buildCandidateDirs(requestedDir)
  const localDir = findLocalCandidate(candidateDirs, ggufs)
  if (localDir) {
    console.log(` ✓ using ${label} GGUFs at ${localDir}`)
    return { targetDir: localDir, cached: true, results: buildResultsMap(ggufs, localDir, true) }
  }

  if (await tryFetchGgufsFromRegistry(ggufs, requestedDir)) {
    return { targetDir: requestedDir, cached: false, results: buildResultsMap(ggufs, requestedDir, false) }
  }

  logMissingGgufs(ggufs, requestedDir)
  throw buildMissingError(label, ggufs, requestedDir, candidateDirs)
}

async function ensureChatterboxModels (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  const located = await locateOrFetchGgufs('Chatterbox', CHATTERBOX_GGUFS, requestedDir)
  return { success: true, results: located.results, targetDir: located.targetDir }
}

async function ensureChatterboxMtlModels (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  const located = await locateOrFetchGgufs('Chatterbox MTL', CHATTERBOX_MTL_GGUFS, requestedDir)
  return { success: true, results: located.results, targetDir: located.targetDir }
}

async function ensureSupertonicModel (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  const located = await locateOrFetchGgufs('Supertonic', SUPERTONIC_GGUFS, requestedDir)
  return { success: true, path: path.join(located.targetDir, 'supertonic.gguf'), targetDir: located.targetDir }
}

async function ensureSupertonicMtlModel (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  const located = await locateOrFetchGgufs('Supertonic MTL', SUPERTONIC_MTL_GGUFS, requestedDir)
  return { success: true, path: path.join(located.targetDir, 'supertonic2.gguf'), targetDir: located.targetDir }
}

module.exports = {
  ensureFileDownloaded,
  ensureWhisperModel,
  ensureChatterboxModels,
  ensureChatterboxMtlModels,
  ensureSupertonicModel,
  ensureSupertonicMtlModel
}
