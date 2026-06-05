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
// registry-server/data/).  Paths mirror the canonical `source` field on
// each model row (the part after `s3:///`); `source` is the prefix
// before `:///`.
//
// Mobile integration tests prefer the q4_0 quantised variants where
// available to stay under Android's per-app memory budget (the S23 FE
// triggered lmkd SIGKILL with the full-precision 1.8 GB Chatterbox
// pair; q4_0 t3 + f16 s3gen drops peak RSS by ~600 MB).
//
//   - chatterbox-t3-turbo / -t3-mtl / supertonic / supertonic2:
//     q4_0 + q8_0 published under qvac_models_compiled/ggml/<engine>/
//     2026-05-18/ (added in qvac2 commit 029aafe6).
//   - chatterbox-s3gen / -s3gen-mtl: only f16 exists under
//     qvac_models_compiled/chatterbox/2026-05-08/ (the vocoder /
//     HiFT side hasn't been quantised yet; once it lands here, point
//     the entries below at the q4_0 path and drop the f16 fallback).
//
// On-disk filenames stay at the historical `<name>.gguf` shape so the
// TTSGgml index.js resolver finds them without changing its hard-coded
// `chatterbox-t3-turbo.gguf` / `chatterbox-s3gen.gguf` / etc. lookups.
// The registry source URL is the only part that differs between
// quantisation levels; tts-cpp reads the quant from the GGUF metadata
// at load time, not from the filename.
const REGISTRY_SOURCE = 's3'
const REGISTRY_DATE_F16 = '2026-05-08' // chatterbox-s3gen* (no quant variant yet)
const REGISTRY_DATE_Q4_0 = '2026-05-18' // chatterbox-t3*, supertonic, supertonic2

// Size bands.  Both bounds are enforced (see `hasAllGgufsIn` below) so a
// stale f16 cache from a previous test run gets rejected and re-fetched
// at the quantised size.  Numbers are deliberately generous: ~50%
// headroom on each side of the actual on-registry size to absorb future
// re-quantisation passes without needing a code change here.
const SIZE_CHATTERBOX_T3_Q4_0 = { minSize: 100_000_000, maxSize: 500_000_000 }
const SIZE_CHATTERBOX_S3GEN_F16 = { minSize: 500_000_000, maxSize: 2_000_000_000 }
const SIZE_SUPERTONIC_Q4_0 = { minSize: 25_000_000, maxSize: 250_000_000 }
const SIZE_SUPERTONIC2_Q4_0 = { minSize: 25_000_000, maxSize: 250_000_000 }

const CHATTERBOX_GGUFS = [
  {
    name: 'chatterbox-t3-turbo.gguf',
    ...SIZE_CHATTERBOX_T3_Q4_0,
    registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_Q4_0}/chatterbox-t3-turbo-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  },
  {
    name: 'chatterbox-s3gen.gguf',
    ...SIZE_CHATTERBOX_S3GEN_F16,
    registryPath: `qvac_models_compiled/chatterbox/${REGISTRY_DATE_F16}/chatterbox-s3gen.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const CHATTERBOX_MTL_GGUFS = [
  {
    name: 'chatterbox-t3-mtl.gguf',
    ...SIZE_CHATTERBOX_T3_Q4_0,
    registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_Q4_0}/chatterbox-t3-mtl-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  },
  {
    name: 'chatterbox-s3gen-mtl.gguf',
    ...SIZE_CHATTERBOX_S3GEN_F16,
    registryPath: `qvac_models_compiled/chatterbox/${REGISTRY_DATE_F16}/chatterbox-s3gen-mtl.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const SUPERTONIC_GGUFS = [
  {
    name: 'supertonic.gguf',
    ...SIZE_SUPERTONIC_Q4_0,
    registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_Q4_0}/supertonic-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const SUPERTONIC_MTL_GGUFS = [
  {
    name: 'supertonic2.gguf',
    ...SIZE_SUPERTONIC2_Q4_0,
    registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_Q4_0}/supertonic2-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

// Compiled MeCab + IPAdic dictionary for Japanese ("ja") morphological
// segmentation inside the multilingual Chatterbox engine.  tts-cpp reads
// this directory via EngineOptions::mecab_dict_path; without it kanji
// degrade to [UNK] (hallucinated audio).  The six files are the standard
// `mecab-dict-index` output and are byte-identical across all target
// platforms (same endianness), so one published copy works everywhere.
//
// S3: bucket tether-ai-dev, region eu-central-1,
//     prefix qvac_models_compiled/chatterbox/mecab-ipadic/
// minSize values are loose truncation guards (a couple of the files are
// only a few hundred bytes); MeCab itself rejects a malformed dictionary
// at init.
const MECAB_IPADIC_DIRNAME = 'mecab-ipadic'
const MECAB_IPADIC_FILES = [
  { name: 'char.bin', minSize: 100_000 },
  { name: 'dicrc', minSize: 100 },
  { name: 'matrix.bin', minSize: 1_000_000 },
  { name: 'mecabrc', minSize: 50 },
  { name: 'sys.dic', minSize: 10_000_000 },
  { name: 'unk.dic', minSize: 1_000 }
].map((f) => ({
  ...f,
  registryPath: `qvac_models_compiled/chatterbox/${MECAB_IPADIC_DIRNAME}/${f.name}`,
  registrySource: REGISTRY_SOURCE
}))

/** Directories searched on Android (in order) when the caller-supplied
 *  `targetDir` doesn't already have both GGUFs.  All of these are
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

function hasAllGgufs (dir) {
  return hasAllGgufsIn(dir, CHATTERBOX_GGUFS)
}

/**
 * Ensure the Chatterbox GGUFs are present under a directory the native
 * addon can read, and return the directory that won.
 *
 * The GGUFs aren't published to a canonical HuggingFace repo yet (the
 * teammate will pick the home when qvac-tts.cpp stabilises), so this
 * helper is **check-only** — it doesn't download anything.  On Android it
 * additionally scans a handful of `adb push`-friendly paths because the
 * mobile test harness's `global.testDir` (the app's internal files dir)
 * isn't writable by `adb push` on stock Android without `run-as`.
 *
 * Dev flow on Android:
 *
 *   adb push models/chatterbox-t3-turbo.gguf /sdcard/qvac-tts-ggml/models/
 *   adb push models/chatterbox-s3gen.gguf    /sdcard/qvac-tts-ggml/models/
 *
 * TODO: once the GGUFs land on a known HuggingFace repo, wire up the
 * download URLs here and switch the default to "fetch from HF".
 */
async function ensureChatterboxModels (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  console.log(`Ensuring Chatterbox GGUFs (requested dir: ${requestedDir})...`)

  const candidateDirs = [requestedDir]
  if (isMobile && platform === 'android') {
    for (const d of ANDROID_CANDIDATE_DIRS) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  } else {
    for (const d of desktopFallbackDirs()) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  }

  let resolvedDir = null
  for (const dir of candidateDirs) {
    if (hasAllGgufs(dir)) {
      resolvedDir = dir
      break
    }
  }

  if (resolvedDir) {
    console.log(` ✓ using Chatterbox GGUFs at ${resolvedDir}`)
    const results = {}
    for (const f of CHATTERBOX_GGUFS) {
      results[f.name] = { success: true, path: path.join(resolvedDir, f.name), cached: true }
    }
    return { success: true, results, targetDir: resolvedDir }
  }

  // No local candidate matched.  Try fetching from the QVAC model
  // registry (writable dir is the caller-supplied `requestedDir`,
  // which on mobile is the app-internal files dir under
  // `global.testDir` — always writable from inside Bare).  Mirrors the
  // SDK / nmtcpp `ensure*` path: registry fetch is opportunistic, and
  // the original "not found" error message still fires if it fails.
  if (await tryFetchGgufsFromRegistry(CHATTERBOX_GGUFS, requestedDir)) {
    const results = {}
    for (const f of CHATTERBOX_GGUFS) {
      results[f.name] = { success: true, path: path.join(requestedDir, f.name), cached: false }
    }
    return { success: true, results, targetDir: requestedDir }
  }

  try {
    if (!fs.existsSync(requestedDir)) fs.mkdirSync(requestedDir, { recursive: true })
  } catch (e) { /* ignore — informational dir only */ }

  const results = {}
  for (const f of CHATTERBOX_GGUFS) {
    const p = path.join(requestedDir, f.name)
    const exists = fs.existsSync(p)
    const size = exists ? fs.statSync(p).size : 0
    console.log(` ✗ ${f.name} ${exists ? `too small (${size} bytes, expected ≥ ${f.minSize})` : `missing at ${p}`}`)
    results[f.name] = { success: false, path: p }
  }
  console.log('')
  if (isMobile && platform === 'android') {
    console.log('Chatterbox GGUFs not found and registry fetch failed.  On Android, ' +
      '`adb push` them to one of:')
    for (const d of ANDROID_CANDIDATE_DIRS) console.log(`  ${d}`)
    console.log('(or copy into the app-internal dir that testDir maps to).')
  } else {
    console.log('Chatterbox GGUFs not found locally and the QVAC registry fetch did')
    console.log('not return a usable file (network / registry unavailable, or the')
    console.log('@qvac/registry-client devDependency is missing).  Either fix the')
    console.log('registry path or generate them locally from the upstream tts-cpp')
    console.log('conversion scripts:')
    console.log('')
    console.log('  git clone git@github.com:tetherto/qvac-ext-lib-whisper.cpp.git')
    console.log('  cd qvac-ext-lib-whisper.cpp/tts-cpp')
    console.log('  python -m venv .venv && . .venv/bin/activate')
    console.log('  pip install torch numpy gguf safetensors scipy librosa resampy')
    console.log('  python scripts/convert-t3-turbo-to-gguf.py --out chatterbox-t3-turbo.gguf')
    console.log('  python scripts/convert-s3gen-to-gguf.py    --out chatterbox-s3gen.gguf')
    console.log('')
    console.log(`Then copy both .gguf files into ${requestedDir}.`)
  }

  return { success: false, results, targetDir: requestedDir }
}

async function ensureChatterboxMtlModels (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  console.log(`Ensuring Chatterbox MTL GGUFs (requested dir: ${requestedDir})...`)

  const candidateDirs = [requestedDir]
  if (isMobile && platform === 'android') {
    for (const d of ANDROID_CANDIDATE_DIRS) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  } else {
    for (const d of desktopFallbackDirs()) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  }

  let resolvedDir = null
  for (const dir of candidateDirs) {
    if (hasAllGgufsIn(dir, CHATTERBOX_MTL_GGUFS)) {
      resolvedDir = dir
      break
    }
  }

  if (resolvedDir) {
    console.log(` ✓ using Chatterbox MTL GGUFs at ${resolvedDir}`)
    const results = {}
    for (const f of CHATTERBOX_MTL_GGUFS) {
      results[f.name] = { success: true, path: path.join(resolvedDir, f.name), cached: true }
    }
    return { success: true, results, targetDir: resolvedDir }
  }

  if (await tryFetchGgufsFromRegistry(CHATTERBOX_MTL_GGUFS, requestedDir)) {
    const results = {}
    for (const f of CHATTERBOX_MTL_GGUFS) {
      results[f.name] = { success: true, path: path.join(requestedDir, f.name), cached: false }
    }
    return { success: true, results, targetDir: requestedDir }
  }

  console.log(' Chatterbox MTL GGUFs not found locally and registry fetch failed.  Convert with:')
  console.log('   python scripts/convert-t3-mtl-to-gguf.py --out chatterbox-t3-mtl.gguf')
  console.log('   python scripts/convert-s3gen-to-gguf.py --variant mtl --out chatterbox-s3gen-mtl.gguf')
  console.log(` and place under one of: ${candidateDirs.join(', ')}`)
  return { success: false, results: {}, targetDir: requestedDir }
}

async function ensureSupertonicModel (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  console.log(`Ensuring Supertonic GGUF (requested dir: ${requestedDir})...`)

  const candidateDirs = [requestedDir]
  if (isMobile && platform === 'android') {
    for (const d of ANDROID_CANDIDATE_DIRS) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  } else {
    for (const d of desktopFallbackDirs()) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  }

  let resolvedDir = null
  for (const dir of candidateDirs) {
    if (hasAllGgufsIn(dir, SUPERTONIC_GGUFS)) {
      resolvedDir = dir
      break
    }
  }

  if (resolvedDir) {
    console.log(` ✓ using Supertonic GGUF at ${resolvedDir}`)
    return {
      success: true,
      path: path.join(resolvedDir, 'supertonic.gguf'),
      targetDir: resolvedDir
    }
  }

  if (await tryFetchGgufsFromRegistry(SUPERTONIC_GGUFS, requestedDir)) {
    return {
      success: true,
      path: path.join(requestedDir, 'supertonic.gguf'),
      targetDir: requestedDir
    }
  }

  console.log(' Supertonic GGUF not found locally and registry fetch failed.  Convert with:')
  console.log('   python scripts/convert-supertonic2-to-gguf.py --arch supertonic --out supertonic.gguf')
  console.log(` and place under one of: ${candidateDirs.join(', ')}`)
  return { success: false, path: null, targetDir: requestedDir }
}

async function ensureSupertonicMtlModel (options = {}) {
  const requestedDir = options.targetDir || path.join(getBaseDir(), 'models')
  console.log(`Ensuring Supertonic MTL GGUF (requested dir: ${requestedDir})...`)

  const candidateDirs = [requestedDir]
  if (isMobile && platform === 'android') {
    for (const d of ANDROID_CANDIDATE_DIRS) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  } else {
    for (const d of desktopFallbackDirs()) {
      if (!candidateDirs.includes(d)) candidateDirs.push(d)
    }
  }

  let resolvedDir = null
  for (const dir of candidateDirs) {
    if (hasAllGgufsIn(dir, SUPERTONIC_MTL_GGUFS)) {
      resolvedDir = dir
      break
    }
  }

  if (resolvedDir) {
    console.log(` ✓ using Supertonic MTL GGUF at ${resolvedDir}`)
    return {
      success: true,
      path: path.join(resolvedDir, 'supertonic2.gguf'),
      targetDir: resolvedDir
    }
  }

  if (await tryFetchGgufsFromRegistry(SUPERTONIC_MTL_GGUFS, requestedDir)) {
    return {
      success: true,
      path: path.join(requestedDir, 'supertonic2.gguf'),
      targetDir: requestedDir
    }
  }

  console.log(' Supertonic MTL GGUF not found locally and registry fetch failed.  Convert with:')
  console.log('   python scripts/convert-supertonic2-to-gguf.py --arch supertonic2 --out supertonic2.gguf')
  console.log(` and place under one of: ${candidateDirs.join(', ')}`)
  return { success: false, path: null, targetDir: requestedDir }
}

/**
 * Ensure the compiled MeCab/IPAdic dictionary is staged in a directory
 * the native addon can read, and return that directory.  Mirrors the
 * `ensureChatterbox*` helpers: prefer an already-staged local copy,
 * otherwise fetch the six files from the QVAC model registry (S3).
 *
 * Pass the returned `dir` to the TTSGgml constructor as
 * `files: { mecabDictDir: dir }` (or top-level `mecabDictPath`) so it
 * reaches tts-cpp's EngineOptions::mecab_dict_path.  Japanese ("ja")
 * synthesis needs it; other languages ignore it.
 *
 * @param {Object} [options]
 * @param {string} [options.targetDir] - where to stage / look for the dict.
 * @returns {Promise<{ success: boolean, dir: string }>}
 */
async function ensureMecabDict (options = {}) {
  const targetDir = options.targetDir ||
    path.join(getBaseDir(), 'models', MECAB_IPADIC_DIRNAME)
  console.log(`Ensuring MeCab/IPAdic dictionary (dir: ${targetDir})...`)

  const candidateDirs = [targetDir]
  if (isMobile && platform === 'android') {
    for (const d of ANDROID_CANDIDATE_DIRS) {
      const md = path.join(d, MECAB_IPADIC_DIRNAME)
      if (!candidateDirs.includes(md)) candidateDirs.push(md)
    }
  } else {
    for (const d of desktopFallbackDirs()) {
      const md = path.join(d, MECAB_IPADIC_DIRNAME)
      if (!candidateDirs.includes(md)) candidateDirs.push(md)
    }
  }

  for (const dir of candidateDirs) {
    if (hasAllGgufsIn(dir, MECAB_IPADIC_FILES)) {
      console.log(` ✓ using MeCab dictionary at ${dir}`)
      return { success: true, dir }
    }
  }

  if (await tryFetchGgufsFromRegistry(MECAB_IPADIC_FILES, targetDir)) {
    return { success: true, dir: targetDir }
  }

  console.log(' MeCab/IPAdic dictionary not found locally and registry fetch failed.')
  console.log(` Expected these files under ${targetDir}:`)
  for (const f of MECAB_IPADIC_FILES) console.log(`   ${f.name}`)
  return { success: false, dir: targetDir }
}

module.exports = {
  ensureFileDownloaded,
  ensureWhisperModel,
  ensureChatterboxModels,
  ensureChatterboxMtlModels,
  ensureSupertonicModel,
  ensureSupertonicMtlModel,
  ensureMecabDict
}
