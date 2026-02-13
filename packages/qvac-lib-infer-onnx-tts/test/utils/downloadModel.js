const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const fflate = require('fflate')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

/**
 * Extract a zip file to a directory using fflate (no subprocess).
 * Works on iOS/Android where unzip command may be unavailable or sandboxed.
 */
function extractZipToDir (zipPath, extractDir) {
  const buf = fs.readFileSync(zipPath)
  const entries = fflate.unzipSync(new Uint8Array(buf))
  const extractDirResolved = path.resolve(extractDir)
  for (const name of Object.keys(entries)) {
    const normalized = name.replace(/\\/g, '/')
    if (normalized.endsWith('/')) continue // directory entry only
    const outPath = path.resolve(extractDir, normalized)
    const rel = path.relative(extractDirResolved, outPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue // path traversal
    const dir = path.dirname(outPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(outPath, Buffer.from(entries[name]))
  }
}

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
        const redirectUrl = location.startsWith('http://') || location.startsWith('https://')
          ? location
          : new URL(location, parsedUrl.origin + parsedUrl.pathname).href
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

// Helper function to download both .onnx and .json files for a TTS model
async function ensureTTSModelPair (modelName) {
  // Parse model name to construct HuggingFace URLs
  // Format: locale-voice-quality (e.g., en_US-amy-low)
  const parts = modelName.split('-')
  const locale = parts[0]
  const voice = parts[1]
  const quality = parts.slice(2).join('-')

  const [language] = locale.split('_')

  // Use resolve (CDN) for binary .onnx; use raw for .json so we get file contents in response body, not an HTML page
  const baseResolve = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${language}/${locale}/${voice}/${quality}`
  const baseRaw = `https://huggingface.co/rhasspy/piper-voices/raw/main/${language}/${locale}/${voice}/${quality}`
  const onnxUrl = `${baseResolve}/${modelName}.onnx`
  const jsonUrl = `${baseRaw}/${modelName}.onnx.json`

  const onnxPath = path.join(getBaseDir(), 'models', 'tts', `${modelName}.onnx`)
  const jsonPath = path.join(getBaseDir(), 'models', 'tts', `${modelName}.onnx.json`)

  console.log(`\nEnsuring model files for ${modelName}...`)

  // Download .onnx file
  const onnxResult = await ensureFileDownloaded(onnxUrl, onnxPath)

  // Download .json file
  const jsonResult = await ensureFileDownloaded(jsonUrl, jsonPath)

  return {
    onnx: onnxResult,
    json: jsonResult,
    success: onnxResult.success && jsonResult.success
  }
}

// Download espeak-ng-data from Google Drive and extract
async function ensureEspeakData (targetPath = null) {
  if (!targetPath) {
    targetPath = path.join(getBaseDir(), 'models', 'tts', 'espeak-ng-data')
  }
  // Check if espeak-ng-data already exists
  if (fs.existsSync(targetPath)) {
    // Verify it has content (check for at least one expected file/folder)
    try {
      const contents = fs.readdirSync(targetPath)
      if (contents.length > 0) {
        console.log(' ✓ espeak-ng-data already exists')
        return { success: true, path: targetPath }
      }
    } catch (e) {
      console.log(' espeak-ng-data directory exists but is invalid, re-downloading...')
    }
  }

  console.log('\nDownloading espeak-ng-data from Google Drive...')
  console.log('Source: https://drive.google.com/file/d/1lJgTw4_TO1BvRpZvmzTXzISCiZpL6wLo')

  const googleDriveFileId = '1lJgTw4_TO1BvRpZvmzTXzISCiZpL6wLo'
  const tmpZipFile = path.join(getBaseDir(), 'espeak-ng-data-tmp.zip')
  const tmpExtractDir = path.join(getBaseDir(), 'espeak-ng-data-tmp')

  // Ensure parent directory exists
  const parentDir = path.dirname(targetPath)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  try {
    // Google Drive direct download URL format
    const url = `https://drive.google.com/uc?export=download&id=${googleDriveFileId}`

    console.log(' Downloading zip file...')

    let downloadSuccess = false

    if (isMobile) {
      // Use HTTP download on mobile
      try {
        const result = await downloadWithHttp(url, tmpZipFile)
        downloadSuccess = result.success && fs.existsSync(tmpZipFile)
      } catch (e) {
        console.log(` HTTP download error: ${e.message}`)
      }
    } else {
      // Use curl on desktop
      const { spawnSync } = require('bare-subprocess')
      const downloadResult = spawnSync('curl', [
        '-L', '-o', tmpZipFile, url,
        '--silent', '--show-error',
        '--connect-timeout', '30',
        '--max-time', '1000'
      ], { stdio: ['inherit', 'inherit', 'pipe'] })
      downloadSuccess = downloadResult.status === 0 && fs.existsSync(tmpZipFile)
      if (!downloadSuccess) {
        console.log(` Download failed with exit code: ${downloadResult.status}`)
      }
    }

    if (!downloadSuccess) {
      return { success: false, path: targetPath }
    }

    const stats = fs.statSync(tmpZipFile)
    console.log(` ✓ Downloaded: ${stats.size} bytes`)

    // Check if file is too small (probably an error page)
    if (stats.size < 1000) {
      console.log(' Downloaded file is too small, possibly an error page')
      fs.unlinkSync(tmpZipFile)
      return { success: false, path: targetPath }
    }

    // Extract the zip file
    console.log(' Extracting zip file...')

    // Create temporary extraction directory
    if (!fs.existsSync(tmpExtractDir)) {
      fs.mkdirSync(tmpExtractDir, { recursive: true })
    }

    let unzipSuccess = false
    if (isMobile) {
      // On iOS/Android, unzip command is often unavailable or sandboxed; use JS extraction
      try {
        extractZipToDir(tmpZipFile, tmpExtractDir)
        unzipSuccess = fs.existsSync(tmpExtractDir) && fs.readdirSync(tmpExtractDir).length > 0
      } catch (e) {
        console.log(` JS unzip error: ${e.message}`)
      }
    } else {
      // Desktop: try unzip command first, fall back to JS extraction
      try {
        const { spawnSync } = require('bare-subprocess')
        const unzipResult = spawnSync('unzip', [
          '-q', '-o', tmpZipFile, '-d', tmpExtractDir
        ], { stdio: ['inherit', 'inherit', 'pipe'] })
        unzipSuccess = unzipResult.status === 0
        if (!unzipSuccess) {
          console.log(` Unzip command failed (exit ${unzipResult.status}), trying JS extraction...`)
          extractZipToDir(tmpZipFile, tmpExtractDir)
          unzipSuccess = fs.existsSync(tmpExtractDir) && fs.readdirSync(tmpExtractDir).length > 0
        }
      } catch (e) {
        console.log(` Unzip error: ${e.message}, trying JS extraction...`)
        try {
          extractZipToDir(tmpZipFile, tmpExtractDir)
          unzipSuccess = fs.existsSync(tmpExtractDir) && fs.readdirSync(tmpExtractDir).length > 0
        } catch (e2) {
          console.log(` JS unzip error: ${e2.message}`)
        }
      }
    }

    if (!unzipSuccess) {
      if (fs.existsSync(tmpZipFile)) fs.unlinkSync(tmpZipFile)
      if (fs.existsSync(tmpExtractDir)) {
        fs.rmSync(tmpExtractDir, { recursive: true, force: true })
      }
      return { success: false, path: targetPath }
    }

    console.log(' ✓ Extracted successfully')

    // Find the espeak-ng-data directory in the extracted contents
    let espeakDataSource = path.join(tmpExtractDir, 'espeak-ng-data')

    if (!fs.existsSync(espeakDataSource)) {
      const contents = fs.readdirSync(tmpExtractDir)
      if (contents.length === 1) {
        const nested = path.join(tmpExtractDir, contents[0])
        if (fs.statSync(nested).isDirectory()) {
          espeakDataSource = nested
        }
      }
    }

    // Move to target location
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true })
    }

    fs.renameSync(espeakDataSource, targetPath)
    console.log(` ✓ Moved to: ${targetPath}`)

    // Clean up temporary files
    if (fs.existsSync(tmpZipFile)) fs.unlinkSync(tmpZipFile)
    if (fs.existsSync(tmpExtractDir)) {
      fs.rmSync(tmpExtractDir, { recursive: true, force: true })
    }

    return { success: true, path: targetPath }
  } catch (e) {
    console.log(` Error: ${e.message}`)

    try {
      if (fs.existsSync(tmpZipFile)) fs.unlinkSync(tmpZipFile)
      if (fs.existsSync(tmpExtractDir)) {
        fs.rmSync(tmpExtractDir, { recursive: true, force: true })
      }
    } catch (cleanupError) {
      // Ignore cleanup errors
    }

    return { success: false, path: targetPath }
  }
}

// Download Whisper model (ggml format)
async function ensureWhisperModel (targetPath = null) {
  if (!targetPath) {
    targetPath = path.join(getBaseDir(), 'models', 'whisper', 'ggml-small.bin')
  }
  // Check if model already exists
  if (fs.existsSync(targetPath)) {
    const stats = fs.statSync(targetPath)
    // ggml-small.bin should be around 460MB
    if (stats.size > 460000000) {
      console.log(` ✓ Whisper model already exists (${stats.size} bytes)`)
      return { success: true, path: targetPath }
    } else {
      console.log(` Cached Whisper model too small (${stats.size} bytes), re-downloading...`)
      fs.unlinkSync(targetPath)
    }
  }

  console.log('\nDownloading Whisper model (ggml-small.bin)...')
  console.log('Source: HuggingFace whisper.cpp')

  // Ensure directory exists
  const dir = path.dirname(targetPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // HuggingFace URL for whisper.cpp models
  const urls = [
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
  ]

  for (const url of urls) {
    console.log(` Trying: ${url}`)

    let downloadSuccess = false

    if (isMobile) {
      // Use HTTP download on mobile
      try {
        const result = await downloadWithHttp(url, targetPath)
        downloadSuccess = result.success && fs.existsSync(targetPath)
      } catch (e) {
        console.log(` HTTP download error: ${e.message}`)
      }
    } else {
      // Use curl on desktop
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

      if (stats.size > 460000000) {
        console.log(' ✓ Whisper model downloaded successfully')
        return { success: true, path: targetPath }
      } else {
        console.log(` Downloaded file too small: ${stats.size} bytes`)
        fs.unlinkSync(targetPath)
      }
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

/**
 * Download Chatterbox ONNX models from HuggingFace
 * Models are downloaded from: https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX
 * @param {Object} options - Download options
 * @param {string} [options.variant='fp32'] - Model variant: 'fp32', 'fp16', 'q4', 'quantized'
 * @param {string} [options.targetDir] - Target directory for models
 * @returns {Promise<Object>} Download result with success status and paths
 */
async function ensureChatterboxModels (options = {}) {
  const variant = options.variant || 'fp32'
  const targetDir = options.targetDir || path.join(getBaseDir(), 'models', 'chatterbox')

  console.log(`\nEnsuring Chatterbox models (variant: ${variant})...`)

  // Ensure target directory exists
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const baseUrl = 'https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/main/onnx'

  // Define file suffixes based on variant
  const suffix = variant === 'fp32' ? '' : `_${variant}`

  // Files to download (each model has .onnx and .onnx_data files)
  const modelFiles = [
    { name: `speech_encoder${suffix}.onnx`, minSize: 1000 },
    { name: `speech_encoder${suffix}.onnx_data`, minSize: 100000000 }, // ~1GB for fp32
    { name: `embed_tokens${suffix}.onnx`, minSize: 1000 },
    { name: `embed_tokens${suffix}.onnx_data`, minSize: 10000000 }, // ~233MB for fp32
    { name: `conditional_decoder${suffix}.onnx`, minSize: 1000 },
    { name: `conditional_decoder${suffix}.onnx_data`, minSize: 100000000 }, // ~769MB for fp32
    { name: `language_model${suffix}.onnx`, minSize: 100000 },
    { name: `language_model${suffix}.onnx_data`, minSize: 100000000 } // ~1.27GB for fp32
  ]

  // Adjust minimum sizes for smaller variants
  if (variant === 'fp16') {
    modelFiles[1].minSize = 50000000 // ~522MB
    modelFiles[3].minSize = 5000000 // ~116MB
    modelFiles[5].minSize = 50000000 // ~384MB
    modelFiles[7].minSize = 50000000 // ~635MB
  } else if (variant === 'q4' || variant === 'quantized') {
    modelFiles[1].minSize = 20000000
    modelFiles[3].minSize = 2000000
    modelFiles[5].minSize = 20000000
    modelFiles[7].minSize = 20000000
  }

  const results = {}
  let allSuccess = true

  for (const file of modelFiles) {
    const url = `${baseUrl}/${file.name}`
    // Save with standard names (without variant suffix) for easier usage
    const targetName = file.name.replace(suffix, '')
    const targetPath = path.join(targetDir, targetName)

    console.log(`\n Downloading ${file.name}...`)

    // Check if file already exists with sufficient size
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath)
      if (stats.size >= file.minSize) {
        console.log(` ✓ Using cached: ${targetName} (${stats.size} bytes)`)
        results[targetName] = { success: true, path: targetPath, cached: true }
        continue
      } else {
        console.log(` Cached file too small (${stats.size} bytes), re-downloading...`)
        fs.unlinkSync(targetPath)
      }
    }

    // Download the file
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
          '--max-time', '1800' // 30 minutes for large files
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
        console.log(` ✓ Downloaded: ${targetName} (${stats.size} bytes)`)
        results[targetName] = { success: true, path: targetPath, cached: false }
      } else {
        console.log(` Downloaded file too small: ${stats.size} bytes (expected >${file.minSize})`)
        fs.unlinkSync(targetPath)
        results[targetName] = { success: false, path: targetPath }
        allSuccess = false
      }
    } else {
      results[targetName] = { success: false, path: targetPath }
      allSuccess = false
    }
  }

  // Download tokenizer.json separately (it's in a different location)
  const tokenizerUrl = 'https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/main/tokenizer.json'
  const tokenizerPath = path.join(targetDir, 'tokenizer.json')

  console.log('\n Downloading tokenizer.json...')

  if (fs.existsSync(tokenizerPath)) {
    const stats = fs.statSync(tokenizerPath)
    if (stats.size > 1000) {
      console.log(` ✓ Using cached: tokenizer.json (${stats.size} bytes)`)
      results['tokenizer.json'] = { success: true, path: tokenizerPath, cached: true }
    } else {
      fs.unlinkSync(tokenizerPath)
    }
  }

  if (!results['tokenizer.json']?.success) {
    let downloadSuccess = false

    if (isMobile) {
      try {
        const result = await downloadWithHttp(tokenizerUrl, tokenizerPath)
        downloadSuccess = result.success && fs.existsSync(tokenizerPath)
      } catch (e) {
        console.log(` HTTP download error: ${e.message}`)
      }
    } else {
      try {
        const { spawnSync } = require('bare-subprocess')
        const downloadResult = spawnSync('curl', [
          '-L', '-o', tokenizerPath, tokenizerUrl,
          '--fail', '--show-error',
          '--connect-timeout', '30',
          '--max-time', '300'
        ], { stdio: ['inherit', 'inherit', 'pipe'] })
        downloadSuccess = downloadResult.status === 0 && fs.existsSync(tokenizerPath)
      } catch (e) {
        console.log(` Curl error: ${e.message}`)
      }
    }

    if (downloadSuccess) {
      const stats = fs.statSync(tokenizerPath)
      console.log(` ✓ Downloaded: tokenizer.json (${stats.size} bytes)`)
      results['tokenizer.json'] = { success: true, path: tokenizerPath, cached: false }
    } else {
      results['tokenizer.json'] = { success: false, path: tokenizerPath }
      allSuccess = false
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('CHATTERBOX MODEL DOWNLOAD SUMMARY')
  console.log('='.repeat(50))
  for (const [name, result] of Object.entries(results)) {
    const status = result.success ? '✓' : '✗'
    const cached = result.cached ? ' (cached)' : ''
    console.log(` ${status} ${name}${cached}`)
  }
  console.log('='.repeat(50))

  return {
    success: allSuccess,
    results,
    targetDir
  }
}

module.exports = { ensureFileDownloaded, ensureTTSModelPair, ensureEspeakData, ensureWhisperModel, ensureChatterboxModels }
