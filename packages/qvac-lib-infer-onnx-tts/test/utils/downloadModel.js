const fs = require('bare-fs')
const path = require('bare-path')

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

  // Get expected file size from URL
  const expectedSize = getFileSizeFromUrl(url)
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

  const onnxPath = `./models/tts/${modelName}.onnx`
  const jsonPath = `./models/tts/${modelName}.onnx.json`

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
async function ensureEspeakData (targetPath = './models/tts/espeak-ng-data') {
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
  const tmpZipFile = './espeak-ng-data-tmp.zip'
  const tmpExtractDir = './espeak-ng-data-tmp'

  // Ensure parent directory exists
  const parentDir = path.dirname(targetPath)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  try {
    const { spawnSync } = require('bare-subprocess')

    // Download from Google Drive
    // Google Drive direct download URL format
    const url = `https://drive.google.com/uc?export=download&id=${googleDriveFileId}`

    console.log(' Downloading zip file...')
    const downloadResult = spawnSync('curl', [
      '-L', '-o', tmpZipFile, url,
      '--silent', '--show-error',
      '--connect-timeout', '30',
      '--max-time', '1000' // 10 minutes for large file
    ], { stdio: ['inherit', 'inherit', 'pipe'] })

    if (downloadResult.status !== 0 || !fs.existsSync(tmpZipFile)) {
      console.log(` Download failed with exit code: ${downloadResult.status}`)
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

    const unzipResult = spawnSync('unzip', [
      '-q', // quiet mode
      '-o', // overwrite files
      tmpZipFile,
      '-d', tmpExtractDir
    ], { stdio: ['inherit', 'inherit', 'pipe'] })

    if (unzipResult.status !== 0) {
      console.log(` Unzip failed with exit code: ${unzipResult.status}`)
      // Clean up
      if (fs.existsSync(tmpZipFile)) fs.unlinkSync(tmpZipFile)
      if (fs.existsSync(tmpExtractDir)) {
        fs.rmSync(tmpExtractDir, { recursive: true, force: true })
      }
      return { success: false, path: targetPath }
    }

    console.log(' ✓ Extracted successfully')

    // Find the espeak-ng-data directory in the extracted contents
    // It might be directly in tmpExtractDir or nested one level
    let espeakDataSource = path.join(tmpExtractDir, 'espeak-ng-data')

    if (!fs.existsSync(espeakDataSource)) {
      // Check if the extracted folder itself contains espeak data
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

    // Clean up on error
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
async function ensureWhisperModel (targetPath = './models/whisper/ggml-small.bin') {
  // Check if model already exists
  if (fs.existsSync(targetPath)) {
    const stats = fs.statSync(targetPath)
    // ggml-small.bin should be around 460MB
    if (stats.size > 460000000) { // At least 460MB
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

  try {
    const { spawnSync } = require('bare-subprocess')

    for (const url of urls) {
      console.log(` Trying: ${url}`)

      const downloadResult = spawnSync('curl', [
        '-L', '-o', targetPath, url,
        '--fail', '--show-error',
        '--connect-timeout', '30',
        '--max-time', '1000' // 10 minutes for ~460MB file
      ], { stdio: ['inherit', 'inherit', 'pipe'] })

      if (downloadResult.status === 0 && fs.existsSync(targetPath)) {
        const stats = fs.statSync(targetPath)
        console.log(` ✓ Downloaded: ${stats.size} bytes`)

        // Verify file size is reasonable (at least 460MB for small model)
        if (stats.size > 460000000) {
          console.log(' ✓ Whisper model downloaded successfully')
          return { success: true, path: targetPath }
        } else {
          console.log(` Downloaded file too small: ${stats.size} bytes`)
          fs.unlinkSync(targetPath)
        }
      } else {
        console.log(` Download failed with exit code: ${downloadResult.status}`)
      }
    }

    // If all URLs failed, create a placeholder for error handling
    console.log(' Warning: All download attempts failed')
    console.log(' Creating placeholder file for error testing')
    fs.writeFileSync(targetPath, Buffer.alloc(1024))
    return { success: false, path: targetPath }
  } catch (e) {
    console.log(` Error: ${e.message}`)

    // Create placeholder on error
    try {
      fs.writeFileSync(targetPath, Buffer.alloc(1024))
    } catch (writeError) {
      // Ignore
    }

    return { success: false, path: targetPath }
  }
}

module.exports = { downloadRealModel, ensureTTSModelPair, ensureEspeakData, ensureWhisperModel }
