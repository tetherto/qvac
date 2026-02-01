'use strict'

const LlmLlamacpp = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
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

  // 1. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
    'Llama-3.2-1B-Instruct-Q4_0.gguf'
  )

  // 2. Initializing data loader
  const fsDL = new FilesystemDL({ dirPath })

  // 3. Configuring model settings
  const args = {
    loader: fsDL,
    opts: { stats: true },
    logger: console,
    diskPath: dirPath,
    modelName
  }

  const config = {
    gpu_layers: '99',
    ctx_size: '512',
    n_predict: '30',
    temp: '0.7',
    device: 'gpu'
  }

  // 4. Loading model
  const model = new LlmLlamacpp(args, config)
  await model.load()

  try {
    // 5. Running inference
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is bitcoin?' }
    ]

    const response = await model.run(messages)
    let fullResponse = ''

    await response
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log(`Full response: "${fullResponse.trim()}"`)
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 6. Cleaning up resources
    await model.unload()
    await fsDL.close()
  }
}

main().catch(error => {
  console.error('Fatal error in main function:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  })
  process.exit(1)
})
