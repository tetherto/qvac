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

module.exports = { downloadModel }
