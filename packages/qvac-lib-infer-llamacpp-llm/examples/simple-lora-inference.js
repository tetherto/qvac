'use strict'

const LlamaClient = require('../index')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')
const https = require('bare-https')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
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
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          let redirectUrl = response.headers.location
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
  const modelDir = path.resolve('./models')

  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    console.log(`Found ${modelName}: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
    return [modelName, modelDir]
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`Downloading test model ${modelName}...`)

  await downloadFile(downloadUrl, modelPath)

  const stats = fs.statSync(modelPath)
  console.log(`Model ready: ${(stats.size / 1024 / 1024).toFixed(1)}MB`)
  return [modelName, modelDir]
}

async function main () {
  const [modelName, modelDir] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const loraAdapterPath = './lora_checkpoints/checkpoint_step_00000006/model.gguf'

  const modelPath = path.join(modelDir, modelName)

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    temp: '0.0',
    n_predict: '256',
    lora: loraAdapterPath
  }

  let client
  try {
    client = new LlamaClient({
      files: { model: [modelPath] },
      config,
      logger: console,
      opts: { stats: true }
    })
    await client.load()

    const messages = [
      { role: 'system', content: 'You are a helpful healthcare assistant.' },
      {
        role: 'user',
        content: "Do nurses' involvement in patient education improve outcomes?"
      }
    ]

    const response = await client.run(messages)
    await response.onUpdate(token => {
      process.stdout.write(token)
    }).await()
  } finally {
    if (client) {
      console.log('\n Cleaning up...')
      await client.unload()
      console.log(' Done!')
    }
  }
}

main().catch(async error => {
  console.error('\n Fatal error in LoRA demo:', error.message)
  process.exit(1)
})
