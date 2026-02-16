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

module.exports = { ensureFileDownloaded, ensureWhisperModel, ensureChatterboxModels }
