'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')

async function downloadFile (url, dest) {
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => {
      if (!resolved) { resolved = true; resolve() }
    }
    const safeReject = (err) => {
      if (!resolved) { resolved = true; reject(err) }
    }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    const req = https.request(url, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') return safeReject(unlinkErr)
          let redirectUrl = response.headers.location
          if (redirectUrl.startsWith('/')) {
            const originalUrl = new URL(url)
            redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`
          }
          downloadFile(redirectUrl, dest).then(safeResolve).catch(safeReject)
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
      file.on('close', () => safeResolve())
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
  if (fs.existsSync(modelPath)) return [modelName, modelDir]
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

function getMediaPath (filename) {
  const isMobile = os.platform() === 'ios' || os.platform() === 'android'
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`
    if (global.assetPaths[projectPath]) {
      return global.assetPaths[projectPath].replace('file://', '')
    }
    throw new Error(`Asset not found in testAssets: ${filename}`)
  }
  return path.resolve(__dirname, '../../media', filename)
}

function makeOutputCollector (t, logger = console) {
  const outputText = {}
  let jobCompleted = false
  let generatedData = null
  let stats = null

  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Output') {
      generatedData = output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      stats = output
      logger.log(`Job ${jobId} completed.`)
      if (stats) logger.log(`Job ${jobId} stats: ${JSON.stringify(stats)}`)
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputText,
    get generatedData () { return generatedData },
    get jobCompleted () { return jobCompleted },
    get stats () { return stats }
  }
}

module.exports = {
  ensureModel,
  ensureModelPath,
  getMediaPath,
  makeOutputCollector
}
