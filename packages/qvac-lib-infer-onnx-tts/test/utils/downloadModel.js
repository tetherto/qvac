const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
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
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'))
          return
        }
        console.log(` [HTTPS] Redirecting to: ${res.headers.location}`)
        downloadWithHttp(res.headers.location, filepath, maxRedirects - 1)
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

async function downloadRealModel (url, filepath) {
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
      console.log(` ✓ Using cached model: ${path.basename(filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath, isReal: true }
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
          console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
          return { success: true, path: filepath, isReal: true }
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
            console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
            return { success: true, path: filepath, isReal: true }
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

  console.log(' Creating placeholder model for error testing')
  fs.writeFileSync(filepath, Buffer.alloc(1024))
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

  const baseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${language}/${locale}/${voice}/${quality}`
  const onnxUrl = `${baseUrl}/${modelName}.onnx`
  const jsonUrl = `${baseUrl}/${modelName}.onnx.json`

  const onnxPath = path.join(getBaseDir(), 'models', 'tts', `${modelName}.onnx`)
  const jsonPath = path.join(getBaseDir(), 'models', 'tts', `${modelName}.onnx.json`)

  console.log(`\nEnsuring model files for ${modelName}...`)

  // Download .onnx file
  const onnxResult = await downloadRealModel(onnxUrl, onnxPath)

  // Download .json file
  const jsonResult = await downloadRealModel(jsonUrl, jsonPath)

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

    // Use unzip command (available on both desktop and mobile via bare-subprocess)
    // Note: On mobile, this may not work - consider bundling espeak-ng-data as test asset
    let unzipSuccess = false
    try {
      const { spawnSync } = require('bare-subprocess')
      const unzipResult = spawnSync('unzip', [
        '-q', '-o', tmpZipFile, '-d', tmpExtractDir
      ], { stdio: ['inherit', 'inherit', 'pipe'] })
      unzipSuccess = unzipResult.status === 0
      if (!unzipSuccess) {
        console.log(` Unzip failed with exit code: ${unzipResult.status}`)
      }
    } catch (e) {
      console.log(` Unzip error: ${e.message}`)
      // On mobile, unzip may not be available
      // Consider using a JavaScript-based unzip library
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

module.exports = { downloadRealModel, ensureTTSModelPair, ensureEspeakData, ensureWhisperModel }
