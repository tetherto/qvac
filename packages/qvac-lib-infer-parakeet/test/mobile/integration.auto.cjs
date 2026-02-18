'use strict'
require('./integration-runtime.cjs')

const fs = require('bare-fs')
const path = require('bare-path')
const fetch = require('bare-fetch')

const HF_BASE = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main'
const MODEL_FILES = ['vocab.txt', 'encoder-model.onnx', 'decoder_joint-model.onnx', 'encoder-model.onnx.data']

async function downloadFile (url, destPath, name) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
  console.log(`[download] ${name}: ${(contentLength / 1024 / 1024).toFixed(1)}MB`)

  const writeStream = fs.createWriteStream(destPath)
  let bytes = 0
  let lastLog = Date.now()

  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (Date.now() - lastLog > 60000) {
      console.log(`[download] ${name}: ${((bytes / contentLength) * 100).toFixed(0)}%`)
      lastLog = Date.now()
    }
    await new Promise((resolve, reject) => {
      writeStream.write(buffer, (err) => err ? reject(err) : resolve())
    })
  }

  await new Promise(resolve => writeStream.end(resolve))
  console.log(`[download] ${name}: ✓`)
}

/**
 * Downloads model from HuggingFace and runs transcription
 */
async function runTranscriptionTest (dirPath, getAssetPath) { // eslint-disable-line no-unused-vars
  const startTime = Date.now()
  const modelDir = path.join(dirPath, 'parakeet-model')

  console.log('[test] Starting Parakeet transcription test')

  try {
    // Load native addon
    const binding = require('@qvac/transcription-parakeet/binding.js')
    const { ParakeetInterface } = require('@qvac/transcription-parakeet/parakeet.js')
    binding.setLogger((p, m) => console.log(`[onnx:${p}] ${m}`))
    console.log('[test] ✓ Addon loaded')

    // Download model files
    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true })

    for (const name of MODEL_FILES) {
      const dest = path.join(modelDir, name)
      if (fs.existsSync(dest)) {
        console.log(`[test] ${name}: cached`)
        continue
      }
      await downloadFile(`${HF_BASE}/${name}`, dest, name)
    }

    // Initialize Parakeet
    let result = null
    const parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'tdt',
      language: 'en',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1
    }, (_, event, __, output, error) => {
      if (event === 'Output' && output) {
        const segments = Array.isArray(output) ? output : [output]
        for (const seg of segments) {
          if (seg?.text) result = seg.text
        }
      }
      if (error) console.error('[test] Error:', error)
    })

    // Load weights
    for (const filename of MODEL_FILES) {
      const filePath = path.join(modelDir, filename)
      if (!fs.existsSync(filePath)) continue
      // Don't read 2.4GB .data file into memory - C++ loads from disk
      const chunk = filename.endsWith('.data')
        ? new Uint8Array([0])
        : new Uint8Array(fs.readFileSync(filePath))
      await parakeet.loadWeights({ filename, chunk, completed: true })
    }
    await parakeet.activate()
    console.log('[test] ✓ Model loaded')

    // Transcribe
    const audioPath = getAssetPath('sample.raw')
    if (!audioPath) throw new Error('sample.raw not found')

    const rawBuffer = fs.readFileSync(audioPath.replace('file://', ''))
    const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audio = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0

    console.log(`[test] Transcribing ${(audio.length / 16000).toFixed(1)}s audio...`)
    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    // Wait for result
    for (let i = 0; i < 60 && !result; i++) {
      await new Promise(r => setTimeout(r, 2000))
    }

    await parakeet.destroyInstance()
    binding.releaseLogger()

    console.log(`[test] Result: "${result}"`)
    console.log(`[test] ✅ PASSED in ${((Date.now() - startTime) / 1000).toFixed(0)}s`)

    return {
      summary: { total: 1, passed: 1, failed: 0 },
      result: { fullText: result }
    }
  } catch (error) {
    console.error(`[test] ❌ FAILED: ${error.message}`)
    return { summary: { total: 1, passed: 0, failed: 1 }, output: error.message }
  }
}
