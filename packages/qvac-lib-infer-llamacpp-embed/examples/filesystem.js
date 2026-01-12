'use strict'

const FilesystemDL = require('@qvac/dl-filesystem')
const GGMLBert = require('../index.js')
const process = require('bare-process')
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')

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

async function main () {
  console.log('Filesystem Example: Demonstrates model loading from the file system')
  console.log('===================================================================')

  // 1. Setting up filesystem data loader
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    'gte-large_fp16.gguf'
  )

  const fsDL = new FilesystemDL({ dirPath })

  // 2. Configuring model settings
  const args = {
    loader: fsDL,
    opts: { stats: true },
    logger: console,
    diskPath: dirPath,
    modelName
  }
  const config = '-ngl\t25'

  // 3. Loading model
  const model = new GGMLBert(args, config)
  await model.load()

  try {
    // 4. Generating embeddings
    const query = 'Hello, can you suggest a game I can play with my 1 year old daughter?'
    const response = await model.run(query)
    const embeddings = await response.await()

    console.log('Embeddings shape:', embeddings.length, 'x', embeddings[0].length)
    console.log('First few values of first embedding:')
    console.log(embeddings[0].slice(0, 5))
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
    await model.unload()
    await fsDL.close()
  }
}

main().catch(console.error)
