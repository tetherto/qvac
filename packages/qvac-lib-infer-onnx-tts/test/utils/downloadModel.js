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
 * Mobile-friendly HTTPS download using bare-https
 * Handles redirects and writes directly to file
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
      // Handle redirects (resolve relative Location against current request URL)
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
        downloadWithHttp(redirectUrl, filepath, maxRedirects - 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`))
        return
      }

      // Ensure directory exists
      const dir = path.dirname(filepath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // Create write stream
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
        writeStream.end(() => {
          console.log(` [HTTPS] Download complete: ${downloadedBytes} bytes`)
          resolve({ success: true, size: downloadedBytes })
        })
      })

      res.on('error', (err) => {
        writeStream.end()
        reject(err)
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

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
      if (match) {
        return parseInt(match[1], 10)
      }
    }
  } catch (e) {
    console.log(` Warning: Could not get file size from URL: ${e.message}`)
  }
  return null
}

async function ensureFileDownloaded (url, filepath) {
  const isJson = filepath.endsWith('.json')

  // Ensure the directory exists
  const dir = path.dirname(filepath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Get expected file size from URL (skip on mobile - no curl)
  const expectedSize = isMobile ? null : getFileSizeFromUrl(url)
  const minSize = expectedSize ? Math.floor(expectedSize * 0.9) : (isJson ? 100 : 1000000)

  if (fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath)
    if (stats.size >= minSize) {
      // For .json files, ensure content is valid JSON (reject placeholder or corrupt cache)
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

  console.log(` Downloading model: ${path.basename(filepath)}...`)
  if (expectedSize) {
    console.log(` Expected size: ${expectedSize} bytes`)
  }

  // Use HTTP-based download on mobile, curl on desktop
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
    // Desktop: use curl
    try {
      const { spawnSync } = require('bare-subprocess')

      // For JSON files, fetch content and write to file
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
          if (stats.size >= minSize) {
            if (!isValidJsonCache(filepath)) {
              console.log(' Downloaded file is not valid JSON, discarding')
              fs.unlinkSync(filepath)
            } else {
              console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
              return { success: true, path: filepath, isReal: true }
            }
          } else {
            console.log(` Downloaded file too small: ${stats.size} bytes (expected >${minSize})`)
          }
        } else {
          console.log(` Download failed with exit code: ${result.status}`)
        }
      } else {
        // For binary files (.onnx), download directly to file
        const result = spawnSync('curl', [
          '-L', '-o', filepath, url,
          '--fail', '--silent', '--show-error',
          '--connect-timeout', '30',
          '--max-time', '1000'
        ], { stdio: ['inherit', 'inherit', 'pipe'] })

        if (result.status === 0 && fs.existsSync(filepath)) {
          const stats = fs.statSync(filepath)
          if (stats.size >= minSize) {
            console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
            return { success: true, path: filepath, isReal: true }
          } else {
            console.log(` Downloaded file too small: ${stats.size} bytes (expected >${minSize})`)
          }
        } else {
          console.log(` Download failed with exit code: ${result.status}`)
        }
      }
    } catch (e) {
      console.log(` Download error: ${e.message}`)
    }
  }

  // Only create placeholder for binary files (not JSON) - JSON placeholders would
  // pass the size check (1024 > 100) and cause parse errors on subsequent runs
  if (!isJson) {
    console.log(' Creating placeholder model for error testing')
    fs.writeFileSync(filepath, Buffer.alloc(1024))
  } else {
    console.log(' Skipping placeholder creation for JSON file')
  }
  return { success: false, path: filepath, isReal: false }
}

// Download Whisper model (ggml format). Supports ggml-small.bin and ggml-medium.bin via targetPath.
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

  // Check if model already exists
  if (fs.existsSync(targetPath)) {
    const stats = fs.statSync(targetPath)
    if (stats.size > modelInfo.minSize) {
      console.log(` ✓ Whisper model already exists (${stats.size} bytes)`)
      return { success: true, path: targetPath }
    } else {
      console.log(` Cached Whisper model too small (${stats.size} bytes), re-downloading...`)
      fs.unlinkSync(targetPath)
    }
  }

  console.log(`\nDownloading Whisper model (${modelFile})...`)
  console.log('Source: HuggingFace whisper.cpp')

  // Ensure directory exists
  const dir = path.dirname(targetPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const url = modelInfo.url
  console.log(` Trying: ${url}`)

  let downloadSuccess = false

  if (isMobile) {
    try {
      const result = await downloadWithHttp(url, targetPath)
      downloadSuccess = result.success && fs.existsSync(targetPath)
    } catch (e) {
      console.log(` HTTP download error: ${e.message}`)
    }
  } else {
    try {
      const { spawnSync } = require('bare-subprocess')
      const downloadResult = spawnSync('curl', [
        '-L', '-o', targetPath, url,
        '--fail', '--show-error',
        '--connect-timeout', '30',
        '--max-time', '1000'
      ], { stdio: ['inherit', 'inherit', 'pipe'] })
      downloadSuccess = downloadResult.status === 0 && fs.existsSync(targetPath)
      if (!downloadSuccess) {
        console.log(` Download failed with exit code: ${downloadResult.status}`)
      }
    } catch (e) {
      console.log(` Curl error: ${e.message}`)
    }
  }

  if (downloadSuccess) {
    const stats = fs.statSync(targetPath)
    console.log(` ✓ Downloaded: ${stats.size} bytes`)

    if (stats.size > modelInfo.minSize) {
      console.log(' ✓ Whisper model downloaded successfully')
      return { success: true, path: targetPath }
    } else {
      console.log(` Downloaded file too small: ${stats.size} bytes`)
      fs.unlinkSync(targetPath)
    }
  }

  // If all URLs failed, create a placeholder for error handling
  console.log(' Warning: All download attempts failed')
  console.log(' Creating placeholder file for error testing')
  try {
    fs.writeFileSync(targetPath, Buffer.alloc(1024))
  } catch (writeError) {
    // Ignore
  }
  return { success: false, path: targetPath }
}

const CANGJIE_TSV_MIN_BYTES = 400000

function extractCangjieEntries (raw) {
  const str = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  const entries = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"/g
  let m
  while ((m = re.exec(str)) !== null) {
    const val = m[1]
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
    entries.push(val)
  }
  return entries
}

function writeCangjieJsonArrayToTsv (jsonBody, tsvPath) {
  const data = extractCangjieEntries(jsonBody)
  if (data.length === 0) {
    throw new Error('Cangjie JSON: no entries extracted')
  }
  const lines = []
  const seenFirstCp = new Set()
  for (const entry of data) {
    const tabIdx = entry.indexOf('\t')
    if (tabIdx <= 0) continue
    const ch = entry.slice(0, tabIdx)
    const code = entry.slice(tabIdx + 1)
    if (ch.length === 0) continue
    const cp = ch.codePointAt(0)
    if (seenFirstCp.has(cp)) continue
    seenFirstCp.add(cp)
    lines.push(`${ch}\t${code}`)
  }
  fs.writeFileSync(tsvPath, lines.join('\n') + '\n', 'utf8')
}

async function ensureCangjieTsvForMultilingual (targetDir) {
  const tsvPath = path.join(targetDir, 'Cangjie5_TC.tsv')

  if (fs.existsSync(tsvPath)) {
    const stats = fs.statSync(tsvPath)
    if (stats.size >= CANGJIE_TSV_MIN_BYTES) {
      return { success: true, path: tsvPath, cached: true }
    }
    fs.unlinkSync(tsvPath)
  }

  const cangjieJsonUrl =
    'https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX/resolve/main/Cangjie5_TC.json'
  console.log(' Downloading Cangjie5_TC.json...')
  const fetchResult = await fetchUrlBody(cangjieJsonUrl)
  if (!fetchResult.success || !fetchResult.body) {
    console.log(` Cangjie download failed: ${fetchResult.error || 'unknown'}`)
    return { success: false, path: tsvPath }
  }

  try {
    writeCangjieJsonArrayToTsv(fetchResult.body, tsvPath)
    const stats = fs.statSync(tsvPath)
    if (stats.size >= CANGJIE_TSV_MIN_BYTES) {
      console.log(` Downloaded: Cangjie5_TC.tsv (${stats.size} bytes)`)
      return { success: true, path: tsvPath, cached: false }
    }
    console.log(` Cangjie TSV too small: ${stats.size} bytes`)
    if (fs.existsSync(tsvPath)) fs.unlinkSync(tsvPath)
    return { success: false, path: tsvPath }
  } catch (e) {
    console.log(` Cangjie parse/write error: ${e.message}`)
    if (fs.existsSync(tsvPath)) fs.unlinkSync(tsvPath)
    return { success: false, path: tsvPath }
  }
}

/**
 * Download Chatterbox ONNX models from HuggingFace
 * Models are downloaded from: https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX
 *
 * English (turbo) repo has all variants for every model.
 * Multilingual repo only has variants for language_model; the other three
 * models (speech_encoder, embed_tokens, conditional_decoder) are fp32-only.
 *
 * @param {Object} options - Download options
 * @param {string} [options.variant='fp32'] - Model variant: 'fp32', 'fp16', 'q4', 'q4f16', 'quantized'
 * @param {string} [options.language='en'] - Language: 'en' or 'multilingual'
 * @param {string} [options.targetDir] - Target directory for models
 * @returns {Promise<Object>} Download result with success status and paths
 */
async function ensureChatterboxModels (options = {}) {
  const variant = options.variant || 'fp32'
  const language = options.language || 'en'
  const targetDir = options.targetDir || path.join(getBaseDir(), 'models', language === 'en' ? 'chatterbox' : 'chatterbox-multilingual')

  console.log(`Ensuring Chatterbox models (variant: ${variant}, language: ${language})...`)

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const isMultilingual = language !== 'en'
  const repositoryName = isMultilingual ? 'onnx-community/chatterbox-multilingual-ONNX' : 'ResembleAI/chatterbox-turbo-ONNX'
  const baseUrl = `https://huggingface.co/${repositoryName}/resolve/main/onnx`

  const suffix = variant === 'fp32' ? '' : `_${variant}`
  const lmSuffix = suffix
  const nonLmSuffix = isMultilingual ? '' : suffix

  const modelFilesEng = [
    { name: `speech_encoder${nonLmSuffix}.onnx`, minSize: 1000 },
    { name: `speech_encoder${nonLmSuffix}.onnx_data`, minSize: 950000000 },
    { name: `embed_tokens${nonLmSuffix}.onnx`, minSize: 1000 },
    { name: `embed_tokens${nonLmSuffix}.onnx_data`, minSize: 10000000 },
    { name: `conditional_decoder${nonLmSuffix}.onnx`, minSize: 1000 },
    { name: `conditional_decoder${nonLmSuffix}.onnx_data`, minSize: 100000000 },
    { name: `language_model${lmSuffix}.onnx`, minSize: 100000 },
    { name: `language_model${lmSuffix}.onnx_data`, minSize: 100000000 }
  ]

  const modelFilesMultilingual = [
    { name: 'speech_encoder.onnx', minSize: 1000000 },
    { name: 'speech_encoder.onnx_data', minSize: 500000000 },
    { name: 'embed_tokens.onnx', minSize: 10000 },
    { name: 'embed_tokens.onnx_data', minSize: 50000000 },
    { name: 'conditional_decoder.onnx', minSize: 5000000 },
    { name: 'conditional_decoder.onnx_data', minSize: 400000000 },
    { name: `language_model${lmSuffix}.onnx`, minSize: 150000 },
    { name: `language_model${lmSuffix}.onnx_data`, minSize: 1500000000 }
  ]

  const modelFiles = isMultilingual ? modelFilesMultilingual : modelFilesEng

  if (variant === 'fp16') {
    if (!isMultilingual) {
      modelFiles[1].minSize = 50000000
      modelFiles[3].minSize = 5000000
      modelFiles[5].minSize = 50000000
    }
    modelFiles[7].minSize = isMultilingual ? 750000000 : 50000000
  } else if (variant === 'q4' || variant === 'quantized' || variant === 'q4f16') {
    if (!isMultilingual) {
      modelFiles[1].minSize = 20000000
      modelFiles[3].minSize = 2000000
      modelFiles[5].minSize = 20000000
    }
    modelFiles[7].minSize = isMultilingual ? 300000000 : 20000000
  }

  const results = {}
  let allSuccess = true

  const allFiles = modelFiles.concat([{ name: 'tokenizer.json', minSize: 1000, isTokenizer: true }])

  for (const file of allFiles) {
    const url = file.isTokenizer
      ? `https://huggingface.co/${repositoryName}/resolve/main/tokenizer.json`
      : `${baseUrl}/${file.name}`
    const targetPath = path.join(targetDir, file.name)

    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath)
      if (stats.size >= file.minSize) {
        results[file.name] = { success: true, path: targetPath, cached: true }
        continue
      }
      fs.unlinkSync(targetPath)
    }

    console.log(` Downloading ${file.name}...`)

    let downloadSuccess = false

    if (isMobile) {
      try {
        const result = await downloadWithHttp(url, targetPath)
        downloadSuccess = result.success && fs.existsSync(targetPath)
      } catch (e) {
        console.log(` HTTP download error: ${e.message}`)
      }
    } else {
      try {
        const { spawnSync } = require('bare-subprocess')
        const downloadResult = spawnSync('curl', [
          '-L', '-o', targetPath, url,
          '--fail', '--show-error',
          '--connect-timeout', '30',
          '--max-time', '1800'
        ], { stdio: ['inherit', 'inherit', 'pipe'] })
        downloadSuccess = downloadResult.status === 0 && fs.existsSync(targetPath)
        if (!downloadSuccess) {
          console.log(` Download failed with exit code: ${downloadResult.status}`)
        }
      } catch (e) {
        console.log(` Curl error: ${e.message}`)
      }
    }

    if (downloadSuccess) {
      const stats = fs.statSync(targetPath)
      if (stats.size >= file.minSize) {
        console.log(` Downloaded: ${file.name} (${stats.size} bytes)`)
        results[file.name] = { success: true, path: targetPath, cached: false }
      } else {
        console.log(` Downloaded file too small: ${stats.size} bytes (expected >${file.minSize})`)
        fs.unlinkSync(targetPath)
        results[file.name] = { success: false, path: targetPath }
        allSuccess = false
      }
    } else {
      results[file.name] = { success: false, path: targetPath }
      allSuccess = false
    }
  }

  if (isMultilingual && allSuccess) {
    const cangjieResult = await ensureCangjieTsvForMultilingual(targetDir)
    results['Cangjie5_TC.tsv'] = cangjieResult
    if (!cangjieResult.success) {
      allSuccess = false
    }
  }

  const cachedCount = Object.values(results).filter(r => r.cached).length
  const downloadedCount = Object.values(results).filter(r => r.success && !r.cached).length
  const failedCount = Object.values(results).filter(r => !r.success).length

  if (failedCount > 0) {
    console.log(`Chatterbox models: ${failedCount} failed, ${downloadedCount} downloaded, ${cachedCount} cached`)
    for (const [name, result] of Object.entries(results)) {
      if (!result.success) console.log(` FAILED: ${name}`)
    }
  } else if (downloadedCount > 0) {
    console.log(`Chatterbox models: ${downloadedCount} downloaded, ${cachedCount} cached`)
  } else {
    console.log(`Chatterbox models: all ${cachedCount} cached`)
  }

  return {
    success: allSuccess,
    results,
    targetDir
  }
}

/**
 * Fetch URL response body as string (for JSON etc.). Used when we need to write the received content to a file.
 * @param {string} url - URL to fetch
 * @returns {Promise<{ success: boolean, body?: string, error?: string }>}
 */
async function fetchUrlBody (url) {
  if (isMobile) {
    const https = require('bare-https')
    const { URL } = require('bare-url')
    return new Promise((resolve) => {
      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bare-download/1.0)' }
      }
      const req = https.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
          fetchUrlBody(redirectUrl).then(resolve).catch((e) => resolve({ success: false, error: e.message }))
          return
        }
        if (res.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${res.statusCode}` })
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ success: true, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (err) => resolve({ success: false, error: err.message }))
      })
      req.on('error', (err) => resolve({ success: false, error: err.message }))
      req.end()
    })
  }
  const { spawnSync } = require('bare-subprocess')
  const result = spawnSync('curl', [
    '-L', url,
    '--fail', '--silent', '--show-error',
    '--connect-timeout', '30',
    '--max-time', '300'
  ], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
  if (result.status === 0 && result.stdout) {
    return { success: true, body: result.stdout }
  }
  return { success: false, error: result.stderr || `exit code ${result.status}` }
}

/**
 * Ensure Supertonic TTS models are present. Downloads from Hugging Face if missing.
 * Source: https://huggingface.co/onnx-community/Supertonic-TTS-ONNX (onnx/, voices/, tokenizer.json).
 * tokenizer.json is fetched as content and written to file (resolve/main returns the file content).
 * @param {Object} options - Download options
 * @param {string} [options.targetDir] - Target directory (default: getBaseDir()/models/supertonic)
 * @param {string[]} [options.voiceNames=['F1']] - Voice files to download (e.g. F1.bin, M1.bin)
 * @returns {Promise<Object>} { success, results, targetDir }
 */
function downloadOnnxFile (url, targetPath, minSize, label) {
  return new Promise((resolve) => {
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath)
      if (stats.size >= minSize) {
        resolve({ success: true, path: targetPath, cached: true })
        return
      }
      fs.unlinkSync(targetPath)
    }

    console.log(` Downloading ${label}...`)

    let downloadSuccess = false
    if (isMobile) {
      downloadWithHttp(url, targetPath)
        .then((result) => { downloadSuccess = result.success && fs.existsSync(targetPath) })
        .catch((e) => { console.log(` HTTP download error: ${e.message}`) })
        .finally(() => finalize())
      return
    }

    try {
      const { spawnSync } = require('bare-subprocess')
      const downloadResult = spawnSync('curl', [
        '-L', '-o', targetPath, url,
        '--fail', '--show-error',
        '--connect-timeout', '30',
        '--max-time', '1800'
      ], { stdio: ['inherit', 'inherit', 'pipe'] })
      downloadSuccess = downloadResult.status === 0 && fs.existsSync(targetPath)
    } catch (e) {
      console.log(` Curl error: ${e.message}`)
    }
    finalize()

    function finalize () {
      if (downloadSuccess) {
        const stats = fs.statSync(targetPath)
        if (stats.size >= minSize) {
          console.log(` ✓ Downloaded: ${label} (${stats.size} bytes)`)
          resolve({ success: true, path: targetPath, cached: false })
          return
        }
        fs.unlinkSync(targetPath)
      }
      resolve({ success: false, path: targetPath })
    }
  })
}

async function downloadJsonConfig (url, targetPath, label) {
  if (fs.existsSync(targetPath) && isValidJsonCache(targetPath)) {
    return { success: true, path: targetPath, cached: true }
  }

  console.log(` Downloading ${label}...`)
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)

  const fetchResult = await fetchUrlBody(url)
  if (!fetchResult.success || !fetchResult.body) {
    console.log(` ${label} fetch failed: ${fetchResult.error || 'unknown'}`)
    return { success: false, path: targetPath }
  }

  try {
    const parsed = JSON.parse(fetchResult.body)
    if (typeof parsed !== 'object' || parsed === null) {
      console.log(` ${label} response was not a valid JSON object/array`)
      return { success: false, path: targetPath }
    }
    fs.writeFileSync(targetPath, fetchResult.body, 'utf8')
    console.log(` ✓ Downloaded: ${label} (${Buffer.byteLength(fetchResult.body, 'utf8')} bytes)`)
    return { success: true, path: targetPath, cached: false }
  } catch (e) {
    console.log(` ${label} parse error: ${e.message}`)
    return { success: false, path: targetPath }
  }
}

async function ensureSupertonicModels (options = {}) {
  const targetDir = options.targetDir || path.join(getBaseDir(), 'models', 'supertonic')
  const voiceNames = options.voiceNames || ['F1']

  console.log('Ensuring Supertonic TTS models...')

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }
  const onnxDir = path.join(targetDir, 'onnx')
  const voiceStylesDir = path.join(targetDir, 'voice_styles')
  if (!fs.existsSync(onnxDir)) fs.mkdirSync(onnxDir, { recursive: true })
  if (!fs.existsSync(voiceStylesDir)) fs.mkdirSync(voiceStylesDir, { recursive: true })

  const baseUrl = 'https://huggingface.co/Supertone/supertonic-2/resolve/main'

  const onnxFiles = [
    { name: 'duration_predictor.onnx', minSize: 1000000 },
    { name: 'text_encoder.onnx', minSize: 25000000 },
    { name: 'vector_estimator.onnx', minSize: 120000000 },
    { name: 'vocoder.onnx', minSize: 95000000 }
  ]

  const results = {}
  let allSuccess = true

  for (const file of onnxFiles) {
    const url = `${baseUrl}/onnx/${file.name}`
    const targetPath = path.join(onnxDir, file.name)
    const r = await downloadOnnxFile(url, targetPath, file.minSize, `onnx/${file.name}`)
    results['onnx/' + file.name] = r
    if (!r.success) allSuccess = false
  }

  const onnxJsonConfigs = ['tts.json', 'unicode_indexer.json']
  for (const name of onnxJsonConfigs) {
    const r = await downloadJsonConfig(
      `${baseUrl}/onnx/${name}`,
      path.join(onnxDir, name),
      `onnx/${name}`
    )
    results['onnx/' + name] = r
    if (!r.success) allSuccess = false
  }

  for (const voice of voiceNames) {
    const name = voice.endsWith('.json') ? voice : `${voice}.json`
    const r = await downloadJsonConfig(
      `${baseUrl}/voice_styles/${name}`,
      path.join(voiceStylesDir, name),
      `voice_styles/${name}`
    )
    results['voice_styles/' + name] = r
    if (!r.success) allSuccess = false
  }

  const cachedCount = Object.values(results).filter(r => r.cached).length
  const downloadedCount = Object.values(results).filter(r => r.success && !r.cached).length
  const failedCount = Object.values(results).filter(r => !r.success).length

  if (failedCount > 0) {
    console.log(`Supertonic models: ${failedCount} failed, ${downloadedCount} downloaded, ${cachedCount} cached`)
    for (const [name, result] of Object.entries(results)) {
      if (!result.success) console.log(` FAILED: ${name}`)
    }
  } else if (downloadedCount > 0) {
    console.log(`Supertonic models: ${downloadedCount} downloaded, ${cachedCount} cached`)
  } else {
    console.log(`Supertonic models: all ${cachedCount} cached`)
  }

  return {
    success: allSuccess,
    results,
    targetDir
  }
}

const ensureSupertonicModelsMultilingual = ensureSupertonicModels

module.exports = { ensureFileDownloaded, ensureWhisperModel, ensureChatterboxModels, ensureSupertonicModels, ensureSupertonicModelsMultilingual }
