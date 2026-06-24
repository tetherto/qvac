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
    const fileStream = fs.createWriteStream(modelPath)
    let downloaded = 0

    const req = https.request(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        fileStream.destroy()
        req.destroy()
        response.destroy()
        fs.unlink(modelPath, () => {})
        return downloadModel(response.headers.location, filename)
          .then(resolve).catch(reject)
      }

      if (response.statusCode !== 200) {
        fileStream.destroy()
        req.destroy()
        response.destroy()
        fs.unlink(modelPath, () => {})
        return reject(new Error(`Download failed: ${response.statusCode}`))
      }

      const total = parseInt(response.headers['content-length'], 10)

      response.on('data', chunk => {
        downloaded += chunk.length
        if (total) {
          const percent = ((downloaded / total) * 100).toFixed(1)
          const downloadedMB = (downloaded / 1024 / 1024).toFixed(1)
          const totalMB = (total / 1024 / 1024).toFixed(1)
          process.stdout.write(`\r    ${percent}% (${downloadedMB}/${totalMB}MB)`)
        }
      })

      response.pipe(fileStream)
      fileStream.on('close', () => {
        fileStream.destroy()
        req.destroy()
        response.destroy()
        console.log('\nDownload complete!')
        resolve([filename, modelDir])
      })
    })

    req.on('error', err => {
      fileStream.destroy()
      req.destroy()
      fs.unlink(modelPath, () => reject(err))
    })

    req.end()
  })
}

module.exports = { downloadModel }
