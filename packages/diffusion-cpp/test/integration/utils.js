'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')
const addonLogging = require('../../addonLogging')

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

const TRANSIENT_ERROR_CODES = new Set([
  'EAI_NODATA', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ESIZE'
])

function isTransientError (err) {
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true
  if (err.statusCode === 408 || err.statusCode === 429) return true
  if (err.statusCode >= 500) return true
  return false
}

function urlHost (url) {
  try { return new URL(url).host } catch (_) { return url }
}

async function downloadFileOnce (url, dest, opts) {
  opts = opts || {}
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 10
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30000
  const idleTimeoutMs = opts.idleTimeoutMs != null ? opts.idleTimeoutMs : 30000

  return new Promise((resolve, reject) => {
    let settled = false
    let reqTimer = null
    let idleTimer = null

    function done (err) {
      if (settled) return
      settled = true
      clearTimeout(reqTimer)
      clearTimeout(idleTimer)
      if (err) reject(err)
      else resolve()
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      done(err)
    })

    function makeRequest (reqUrl, redirectsLeft) {
      const req = https.request(reqUrl, (response) => {
        clearTimeout(reqTimer)

        if ([301, 302, 307, 308].includes(response.statusCode)) {
          if (redirectsLeft <= 0) {
            file.destroy()
            return done(new Error(`Too many redirects downloading ${urlHost(reqUrl)}`))
          }
          const location = new URL(response.headers.location, reqUrl).href
          makeRequest(location, redirectsLeft - 1)
          return
        }

        if (response.statusCode !== 200) {
          file.destroy()
          const err = new Error(`Download failed: HTTP ${response.statusCode} from ${urlHost(reqUrl)}`)
          err.statusCode = response.statusCode
          return done(err)
        }

        function resetIdleTimer () {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            response.destroy(Object.assign(new Error(`Idle timeout downloading ${urlHost(reqUrl)}`), { code: 'ETIMEDOUT' }))
          }, idleTimeoutMs)
        }

        resetIdleTimer()

        response.on('data', () => resetIdleTimer())

        response.on('error', (err) => {
          file.destroy()
          done(err)
        })

        response.pipe(file)

        file.on('close', () => {
          clearTimeout(idleTimer)
          done(null)
        })
      })

      reqTimer = setTimeout(() => {
        req.destroy(Object.assign(new Error(`Request timeout downloading ${urlHost(reqUrl)}`), { code: 'ETIMEDOUT' }))
      }, timeoutMs)

      req.on('error', (err) => {
        clearTimeout(reqTimer)
        file.destroy()
        done(err)
      })

      req.end()
    }

    makeRequest(url, maxRedirects)
  })
}

async function downloadFileWithRetries (urls, dest, opts) {
  opts = opts || {}
  const retries = opts.retries != null ? opts.retries : 3
  const minBytes = opts.minBytes != null ? opts.minBytes : 1
  const urlList = Array.isArray(urls) ? urls : [urls]
  const partPath = dest + '.part'

  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    const url = urlList[attempt % urlList.length]

    try {
      await downloadFileOnce(url, partPath, opts)

      const stats = fs.statSync(partPath)
      if (stats.size < minBytes) {
        throw Object.assign(new Error(`Downloaded file too small: ${stats.size} bytes from ${urlHost(url)}`), { code: 'ESIZE' })
      }

      fs.renameSync(partPath, dest)
      return
    } catch (err) {
      lastErr = err
      try { fs.unlinkSync(partPath) } catch (_) {}

      const attemptsLeft = retries - attempt
      if (attemptsLeft > 0 && isTransientError(err)) {
        console.log(`[download] Attempt ${attempt + 1} failed (${err.message}), retrying (${attemptsLeft} left)...`)
      } else {
        break
      }
    }
  }

  console.log(`[download] All attempts failed: ${lastErr && lastErr.message}`)
  throw lastErr
}

async function ensureModel ({ modelName, downloadUrl }) {
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    if (stats.size === 0) {
      console.log(`[download] Removing zero-byte cached file: ${modelName}`)
      fs.unlinkSync(modelPath)
    } else {
      return [modelName, modelDir]
    }
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`[download] Downloading test model ${modelName}...`)

  await downloadFileWithRetries(downloadUrl, modelPath)

  const stats = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
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

function setupJsLogger (binding = addonLogging) {
  const priorityNames = {
    0: 'ERROR',
    1: 'WARNING',
    2: 'INFO',
    3: 'DEBUG'
  }

  binding.setLogger((priority, message) => {
    const priorityName = priorityNames[priority] || `UNKNOWN(${priority})`
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [C++ TEST] [${priorityName}]: ${message}`)
  })
  return binding
}

function releaseJsLogger (binding = addonLogging) {
  try {
    binding.releaseLogger()
  } catch (_) {}
}

function withIntegrationDefaults (args) {
  return {
    ...args,
    config: {
      ...(args.config || {}),
      verbosity: 2
    },
    opts: {
      ...(args.opts || {}),
      stats: true
    }
  }
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

const test = require('brittle')

function safeTest (name, opts, fn) {
  test(name, opts, async (t) => {
    setupJsLogger()
    try {
      await fn(t)
    } catch (err) {
      console.error(err)
      t.fail(`${name}: ${err.message}`)
    } finally {
      releaseJsLogger()
    }
  })
}

module.exports = {
  GeneratedImageSaver,
  ensureModel,
  ensureModelPath,
  getMediaPath,
  makeOutputCollector,
  detectPlatform,
  setupJsLogger,
  releaseJsLogger,
  withIntegrationDefaults,
  isPng,
  safeTest
}
