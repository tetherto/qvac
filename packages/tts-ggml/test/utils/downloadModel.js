'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

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

/**
 * Ensure the Chatterbox GGUFs are present under `targetDir` as
 *   `chatterbox-t3-turbo.gguf` and `chatterbox-s3gen.gguf`.
 *
 * The GGUFs aren't published to a canonical HuggingFace repo yet (the
 * teammate will pick the home when qvac-tts.cpp stabilises), so for now
 * this helper is **check-only**: it verifies the two files exist and, if
 * they don't, prints actionable instructions for regenerating them from
 * the chatterbox.cpp conversion scripts.
 *
 * TODO: once the GGUFs land on a known HuggingFace repo (e.g.
 * `tetherto/qvac-tts-ggml`), wire up the download URLs here and switch
 * the default to "fetch from HF".
 */
async function ensureChatterboxModels (options = {}) {
  const targetDir = options.targetDir || path.join(getBaseDir(), 'models')
  console.log(`Ensuring Chatterbox GGUFs under ${targetDir}...`)

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const files = [
    { name: 'chatterbox-t3-turbo.gguf', minSize: 500_000_000 },
    { name: 'chatterbox-s3gen.gguf', minSize: 500_000_000 }
  ]

  const results = {}
  let allSuccess = true

  for (const f of files) {
    const targetPath = path.join(targetDir, f.name)
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath)
      if (stats.size >= f.minSize) {
        console.log(` ✓ ${f.name} present (${stats.size} bytes)`)
        results[f.name] = { success: true, path: targetPath, cached: true }
        continue
      }
      console.log(` ✗ ${f.name} exists but is too small (${stats.size} bytes, expected ≥ ${f.minSize})`)
    } else {
      console.log(` ✗ ${f.name} missing at ${targetPath}`)
    }
    results[f.name] = { success: false, path: targetPath }
    allSuccess = false
  }

  if (!allSuccess) {
    console.log('')
    console.log('Chatterbox GGUFs are not published on HuggingFace yet.  Generate them')
    console.log('locally from the qvac-tts.cpp (née chatterbox.cpp) conversion scripts:')
    console.log('')
    console.log('  git clone git@github.com:GustavoA1604/chatterbox.cpp.git chatterbox.cpp')
    console.log('  cd chatterbox.cpp')
    console.log('  python -m venv .venv && . .venv/bin/activate')
    console.log('  pip install torch numpy gguf safetensors scipy librosa resampy')
    console.log('  python scripts/convert-t3-turbo-to-gguf.py --out chatterbox-t3-turbo.gguf')
    console.log('  python scripts/convert-s3gen-to-gguf.py    --out chatterbox-s3gen.gguf')
    console.log('')
    console.log(`Then copy both .gguf files into ${targetDir}.`)
  }

  return { success: allSuccess, results, targetDir }
}

module.exports = {
  ensureFileDownloaded,
  ensureWhisperModel,
  ensureChatterboxModels
}
