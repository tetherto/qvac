'use strict'

// const LlamaClient = require('../index') // Use to debug package
const LlamaClient = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const process = require('bare-process')
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')

// Download model function
async function downloadModel (url, filename) {
  const modelDir = './demo-models'
  const modelPath = path.join(modelDir, filename)

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    console.log(` Found ${filename}: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
    return modelPath
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(` Downloading ${filename}...`)

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(modelPath)
    let downloaded = 0

    const req = https.request(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.destroy()
        fs.unlink(modelPath, () => {})
        return downloadModel(response.headers.location, filename)
          .then(resolve).catch(reject)
      }

      if (response.statusCode !== 200) {
        file.destroy()
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

      response.pipe(file)
      file.on('finish', () => {
        file.destroy()
        console.log('\n    Download complete!')
        resolve(modelPath)
      })
    })

    req.on('error', err => {
      file.destroy()
      fs.unlink(modelPath, () => reject(err))
    })

    req.end()
  })
}

// Simple function to run multiple inferences with one client
async function qwenSingleClientDemo () {
  console.log(' Qwen Single LlamaClient Demo')
  console.log('===================================\n')

  let client = null

  try {
    // 1. Download the model first (Qwen model)
    console.log(' Downloading Qwen model...')
    const modelPath = await downloadModel(
      'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_0.gguf',
      'qwen2.5-1.5b-instruct.gguf'
    )

    // 2. Initialize the client once
    console.log('\n Setting up LlamaClient...')

    const fsDL = new FilesystemDL({
      dirPath: path.dirname(modelPath)
    })

    const args = {
      loader: fsDL,
      opts: { stats: true },
      logger: console,
      saveWeightsToDisk: false,
      diskPath: path.dirname(modelPath),
      modelName: path.basename(modelPath)
    }

    const config = {
      gpu_layers: '99',
      ctx_size: '512',
      n_predict: '30',
      temp: '0.7',
      system_prompt: 'You are a helpful assistant.',
      device: 'gpu'
    }

    client = new LlamaClient(args, config)
    await client.load()
    console.log(' Client loaded successfully!\n')

    // 3. Run multiple inferences using the same client
    const questions = [
      'What is 2+2?',
      'Tell me a short joke.',
      'What color is the sky?',
      'Count from 1 to 5.'
    ]

    for (let i = 0; i < questions.length; i++) {
      console.log(`\n Question ${i + 1}: "${questions[i]}"`)
      console.log(' Response: ', { end: '' })

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: questions[i] }
      ]

      const response = await client.run(messages)
      let output = ''

      // Stream the response
      await response.onUpdate(token => {
        output += token
        process.stdout.write(token)
      }).await()

      console.log(`\n Complete response: "${output.trim()}"`)
      console.log(`\n Stats: ${JSON.stringify(response.stats)}`)
      console.log('-'.repeat(50))
    }
  } catch (error) {
    console.error(' Error:', error.message)
  } finally {
    // 4. Clean up when done
    if (client) {
      console.log('\n Cleaning up...')
      await client.unload()
      console.log(' Done!')
    }
  }
}

// Run the demo
qwenSingleClientDemo().catch(console.error)
