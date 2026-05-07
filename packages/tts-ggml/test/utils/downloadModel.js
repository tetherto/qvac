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

const CHATTERBOX_GGUFS = [
  { name: 'chatterbox-t3-turbo.gguf', minSize: 500_000_000 },
  { name: 'chatterbox-s3gen.gguf', minSize: 500_000_000 }
]

const CHATTERBOX_MTL_GGUFS = [
  { name: 'chatterbox-t3-mtl.gguf', minSize: 500_000_000 },
  { name: 'chatterbox-s3gen-mtl.gguf', minSize: 500_000_000 }
]

const SUPERTONIC_GGUFS = [
  { name: 'supertonic.gguf', minSize: 100_000_000 }
]

const SUPERTONIC_MTL_GGUFS = [
  { name: 'supertonic2.gguf', minSize: 100_000_000 }
]

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

/** Returns true if `dir` contains every file in `ggufs` at the expected size. */
function hasAllGgufsIn (dir, ggufs) {
  for (const f of ggufs) {
    const p = path.join(dir, f.name)
    if (!fs.existsSync(p)) return false
    try {
      const stats = fs.statSync(p)
      if (stats.size < f.minSize) return false
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
    console.log('Chatterbox GGUFs not found.  On Android, `adb push` them to one of:')
    for (const d of ANDROID_CANDIDATE_DIRS) console.log(`  ${d}`)
    console.log('(or copy into the app-internal dir that testDir maps to).')
  } else {
    console.log('Chatterbox GGUFs are not published on HuggingFace yet.  Generate them')
    console.log('locally from the upstream tts-cpp conversion scripts:')
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

  console.log(' Chatterbox MTL GGUFs not found.  Convert with:')
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

  console.log(' Supertonic GGUF not found.  Convert with:')
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

  console.log(' Supertonic MTL GGUF not found.  Convert with:')
  console.log('   python scripts/convert-supertonic2-to-gguf.py --arch supertonic2 --out supertonic2.gguf')
  console.log(` and place under one of: ${candidateDirs.join(', ')}`)
  return { success: false, path: null, targetDir: requestedDir }
}

module.exports = {
  ensureFileDownloaded,
  ensureWhisperModel,
  ensureChatterboxModels,
  ensureChatterboxMtlModels,
  ensureSupertonicModel,
  ensureSupertonicMtlModel
}
