'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')

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

          let redirectUrl = response.headers.location
          // Handle relative redirects
          if (redirectUrl.startsWith('/')) {
            const originalUrl = new URL(url)
            redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`
          }

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
 *
 * @param {string} filename - Name of the media file (e.g., 'elephant.jpg')
 * @returns {string} - Full path to the media file
 *
 * @example
 * const imagePath = getMediaPath('elephant.jpg')
 * const imageBytes = fs.readFileSync(imagePath)
 */
function getMediaPath (filename) {
  // Mobile environment - use asset loading from testAssets
  const isMobile = os.platform() === 'ios' || os.platform() === 'android'
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    // Asset not found in manifest
    throw new Error(`Asset not found in testAssets: ${filename}. Make sure ${filename} is in testAssets/ directory and rebuild the app.`)
  }

  // Desktop environment - use media directory at addon root
  return path.resolve(__dirname, '../../media', filename)
}

/**
 * Factory to create a shared onOutput handler and expose collected state.
 * Used in tests to capture and track LLM output events.
 *
 * @param {object} t - Test instance
 * @param {object} [logger=console] - Logger instance with a `log` method
 * @returns {{
 *   onOutput: (addon: object, event: string, jobId: string, output: string, error: string) => void,
 *   outputText: Object<string, string>,
 *   generatedText: string,
 *   jobCompleted: boolean,
 *   timeToFirstToken: number | null,
 *   stats: object | null,
 *   setStartTime: (time: number) => void
 * }} An object containing:
 *   - `onOutput` - Callback to handle addon output events ('Output', 'Error', 'JobEnded')
 *   - `outputText` - Map of jobId to accumulated output text
 *   - `generatedText` - All generated text concatenated
 *   - `jobCompleted` - Flag indicating if the job has finished
 *   - `timeToFirstToken` - Time to first token in milliseconds
 *   - `stats` - Stats object from the job
 *   - `setStartTime` - Function to set the start time for timeToFirstToken calculation
 *
 * @example
 * const collector = makeOutputCollector(t)
 * addon.setOnOutputCb(collector.onOutput)
 * // ... run inference ...
 * console.log(collector.generatedText)
 */
function makeOutputCollector (t, logger = console) {
  const outputText = {}
  let jobCompleted = false
  let generatedText = ''
  let timeToFirstToken = null
  let startTime = null
  let stats = null

  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Output') {
      if (!outputText[jobId]) {
        outputText[jobId] = ''
        // Record time to first token (manual fallback)
        if (startTime && timeToFirstToken === null) {
          timeToFirstToken = Date.now() - startTime
        }
      }
      outputText[jobId] += output
      generatedText += output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      // Capture stats from the data parameter (output is actually the data/stats object in JobEnded)
      stats = output
      logger.log(`Job ${jobId} completed. Output: "${outputText[jobId]}"`)
      if (stats) {
        logger.log(`Job ${jobId} stats: ${JSON.stringify(stats)}`)
      }
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputText,
    get generatedText () { return generatedText },
    get jobCompleted () { return jobCompleted },
    get timeToFirstToken () { return timeToFirstToken },
    get stats () { return stats },
    setStartTime (time) { startTime = time }
  }
}

module.exports = {
  ensureModel,
  ensureModelPath,
  getMediaPath,
  makeOutputCollector
}
