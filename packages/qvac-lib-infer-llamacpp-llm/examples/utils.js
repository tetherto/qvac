'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const process = require('bare-process')

async function downloadModel (url, filename) {
  const modelDir = path.resolve('./models')
  const modelPath = path.join(modelDir, filename)

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    console.log(`Found ${filename}: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
    return [filename, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`Downloading ${filename}...`)

  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val) } }
    const safeReject = (err) => { if (!resolved) { resolved = true; reject(err) } }

    const fileStream = fs.createWriteStream(modelPath)

    fileStream.on('error', (err) => {
      fileStream.destroy()
      fs.unlink(modelPath, () => safeReject(err))
    })

    const req = https.request(url, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        fileStream.destroy()
        req.destroy()
        response.destroy()
        fs.unlink(modelPath, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          const redirectUrl = new URL(response.headers.location, url).href

          downloadModel(redirectUrl, filename)
            .then(safeResolve).catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        fileStream.destroy()
        req.destroy()
        response.destroy()
        fs.unlink(modelPath, () => safeReject(new Error(`Download failed: ${response.statusCode}`)))
        return
      }

      const total = parseInt(response.headers['content-length'], 10)
      let downloaded = 0

      response.on('data', chunk => {
        downloaded += chunk.length
        if (total) {
          const percent = ((downloaded / total) * 100).toFixed(1)
          const downloadedMB = (downloaded / 1024 / 1024).toFixed(1)
          const totalMB = (total / 1024 / 1024).toFixed(1)
          process.stdout.write(`\r    ${percent}% (${downloadedMB}/${totalMB}MB)`)
        }
      })

      response.on('error', (err) => {
        fileStream.destroy()
        fs.unlink(modelPath, () => safeReject(err))
      })

      response.pipe(fileStream)
      fileStream.on('close', () => {
        console.log('\nDownload complete!')
        safeResolve([filename, modelDir])
      })
    })

    req.on('error', err => {
      fileStream.destroy()
      fs.unlink(modelPath, () => safeReject(err))
    })

    req.end()
  })
}

function formatTime (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function makeProgressBar (current, total, width) {
  width = width || 20
  if (!total || total <= 0) return '[' + ' '.repeat(width) + ']'
  const filled = Math.round((current / total) * width)
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled) + ']'
}

function formatProgress (stats, totalEpochs) {
  const isTrain = stats.is_train !== false
  const phase = isTrain ? 'train' : 'val  '
  const epoch = Number.isFinite(stats.current_epoch) ? stats.current_epoch + 1 : 1
  const bar = makeProgressBar(stats.current_batch, stats.total_batches)
  const batchStr = `${stats.current_batch}/${stats.total_batches}`
  const loss = Number.isFinite(stats.loss) ? stats.loss.toFixed(4) : 'n/a'
  const acc = Number.isFinite(stats.accuracy) ? (stats.accuracy * 100).toFixed(1) + '%' : 'n/a'
  const elapsed = formatTime(stats.elapsed_ms)
  const eta = formatTime(stats.eta_ms)
  const stepStr = isTrain ? ` step=${stats.global_steps}` : ''
  return `${phase} epoch ${epoch}/${totalEpochs} ${bar} ${batchStr} | loss=${loss} acc=${acc}${stepStr} | ${elapsed}<${eta}`
}

function createFilteredLogger () {
  const originalConsoleLog = console.log
  const originalConsoleInfo = console.info
  const originalConsoleWarn = console.warn

  const shouldSuppress = (args) => {
    const message = args.join(' ')
    return message && message.includes('No response found for job')
  }

  console.log = (...args) => {
    if (shouldSuppress(args)) return
    originalConsoleLog.apply(console, args)
  }

  console.info = (...args) => {
    if (shouldSuppress(args)) return
    originalConsoleInfo.apply(console, args)
  }

  console.warn = (...args) => {
    if (shouldSuppress(args)) return
    originalConsoleWarn.apply(console, args)
  }

  const logger = {
    info: (...args) => {
      if (shouldSuppress(args)) return
      originalConsoleInfo.apply(console, args)
    },
    log: (...args) => {
      if (shouldSuppress(args)) return
      originalConsoleLog.apply(console, args)
    },
    warn: (...args) => {
      if (shouldSuppress(args)) return
      originalConsoleWarn.apply(console, args)
    },
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  }

  function restore () {
    console.log = originalConsoleLog
    console.info = originalConsoleInfo
    console.warn = originalConsoleWarn
  }

  return { logger, restore }
}

module.exports = { downloadModel, formatProgress, createFilteredLogger }
