'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')

const ANDROID_GENERATED_IMAGE_ARTIFACT_DIRS = [
  '/sdcard/Download/qvac-generated-images',
  '/storage/emulated/0/Download/qvac-generated-images'
]

class GeneratedImageSaver {
  constructor (modelDir) {
    const platform = os.platform()

    try {
      if (platform === 'android') {
        for (const artifactDir of ANDROID_GENERATED_IMAGE_ARTIFACT_DIRS) {
          try {
            fs.mkdirSync(artifactDir, { recursive: true })
            this.artifactDir = artifactDir
            break
          } catch (_) {}
        }
        return
      }

      // Use a separate directory on iOS to avoid pulling the model file on device farm runs.
      this.artifactDir = platform === 'ios'
        ? path.resolve(modelDir, '../generated-images')
        : modelDir
      fs.mkdirSync(this.artifactDir, { recursive: true })
    } catch (err) {
      console.log(`Could not prepare artifact directory: ${err.message}`)
    }
  }

  save (filename, imageData) {
    if (!this.artifactDir) return

    const outputPath = path.join(this.artifactDir, filename)

    try {
      fs.writeFileSync(outputPath, imageData)
      console.log(`Image saved to ${outputPath}`)
    } catch (err) {
      console.log(`Could not save image to ${this.artifactDir}: ${err.message}`)
    }
  }
}

async function downloadFile (url, dest) {
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    }
    const safeReject = (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    }

    const file = fs.createWriteStream(dest)

    file.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    const req = https.request(url, response => {
      // Handle redirects (added 307, 308 for Windows model download)
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        // Wait for unlink to complete before recursive call (fixes Windows race condition)
        fs.unlink(dest, (unlinkErr) => {
          // Ignore ENOENT - file may not exist yet
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          const redirectUrl = new URL(response.headers.location, url).href

          downloadFile(redirectUrl, dest)
            .then(safeResolve)
            .catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        file.destroy()
        fs.unlink(dest, () => safeReject(new Error(`Download failed: HTTP ${response.statusCode} from ${url}`)))
        return
      }

      response.on('error', (err) => {
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })

      response.pipe(file)

      // Wait for 'close' event to ensure data is fully flushed to disk (important on Windows)
      file.on('close', () => {
        safeResolve()
      })
    })

    req.on('error', err => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    req.end()
  })
}

async function ensureModel ({ modelName, downloadUrl }) {
  const modelDir = path.resolve(__dirname, '../model')

  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    return [modelName, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`Downloading test model ${modelName}...`)

  await downloadFile(downloadUrl, modelPath)

  const stats = fs.statSync(modelPath)
  console.log(`Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
  return [modelName, modelDir]
}

async function ensureModelPath ({ modelName, downloadUrl }) {
  const [downloadedModelName, modelDir] = await ensureModel({ modelName, downloadUrl })
  return path.join(modelDir, downloadedModelName)
}

/**
 * Get path to a media file - works on both desktop and mobile
 * On mobile, media files must be in testAssets/
 * On desktop, media files are in addon root /media/
 */
function getMediaPath (filename) {
  const isMobile = os.platform() === 'ios' || os.platform() === 'android'
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    throw new Error(`Asset not found in testAssets: ${filename}. Make sure ${filename} is in testAssets/ directory and rebuild the app.`)
  }

  return path.resolve(__dirname, '../../media', filename)
}

/**
 * Factory to create a shared onOutput handler for image generation.
 */
function makeOutputCollector (t, logger = console) {
  const outputData = {}
  let jobCompleted = false
  let generatedData = null
  let stats = null

  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Output') {
      if (!outputData[jobId]) {
        outputData[jobId] = []
      }
      outputData[jobId].push(output)
      generatedData = output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      stats = output
      logger.log(`Job ${jobId} completed.`)
      if (stats) {
        logger.log(`Job ${jobId} stats: ${JSON.stringify(stats)}`)
      }
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputData,
    get generatedData () { return generatedData },
    get jobCompleted () { return jobCompleted },
    get stats () { return stats }
  }
}

function detectPlatform () {
  return `${os.platform()}-${os.arch()}`
}

function setupJsLogger (binding) {
  const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
  binding.setLogger((priority, message) => {
    const label = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${label}] ${message}`)
  })
  return binding
}

function isPng (buf) {
  if (!buf || buf.length < 8) return false
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4E &&
    buf[3] === 0x47 &&
    buf[4] === 0x0D &&
    buf[5] === 0x0A &&
    buf[6] === 0x1A &&
    buf[7] === 0x0A
  )
}

module.exports = {
  GeneratedImageSaver,
  ensureModel,
  ensureModelPath,
  getMediaPath,
  makeOutputCollector,
  detectPlatform,
  setupJsLogger,
  isPng
}
