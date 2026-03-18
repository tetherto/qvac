'use strict'
require('./integration-runtime.cjs')

const fs = require('bare-fs')
const path = require('bare-path')
const fetch = require('bare-fetch')

const HF_BASE = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main'
const PREPROCESSOR_URL = 'https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx'
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
 * Build named-paths config for a given model type and directory.
 * C++ loads directly from these paths (no JS buffer loading needed).
 */
function getNamedPathsConfig (modelType, modelDir) {
  switch (modelType) {
    case 'ctc':
      return {
        ctcModelPath: path.join(modelDir, 'model.onnx'),
        ctcModelDataPath: path.join(modelDir, 'model.onnx_data'),
        tokenizerPath: path.join(modelDir, 'tokenizer.json')
      }
    case 'eou':
      return {
        eouEncoderPath: path.join(modelDir, 'encoder.onnx'),
        eouDecoderPath: path.join(modelDir, 'decoder_joint.onnx'),
        tokenizerPath: path.join(modelDir, 'tokenizer.json')
      }
    case 'sortformer':
      return {
        sortformerPath: path.join(modelDir, 'sortformer.onnx')
      }
    case 'tdt':
    default:
      return {
        encoderPath: path.join(modelDir, 'encoder-model.onnx'),
        encoderDataPath: path.join(modelDir, 'encoder-model.onnx.data'),
        decoderPath: path.join(modelDir, 'decoder_joint-model.onnx'),
        vocabPath: path.join(modelDir, 'vocab.txt'),
        preprocessorPath: path.join(modelDir, 'preprocessor.onnx')
      }
  }
}

/**
 * Downloads model from HuggingFace and runs transcription
 */
async function runTranscriptionTest (dirPath, getAssetPath) { // eslint-disable-line no-unused-vars
  const startTime = Date.now()
  const modelDir = path.join(dirPath, 'parakeet-model')

  console.log('[test] Starting Parakeet transcription test')

  let binding = null
  let parakeet = null

  try {
    binding = require('@qvac/transcription-parakeet/binding.js')
    const { ParakeetInterface } = require('@qvac/transcription-parakeet/parakeet.js')
    binding.setLogger((p, m) => console.log(`[onnx:${p}] ${m}`))
    console.log('[test] ✓ Addon loaded')

    const requiredFns = ['createInstance', 'runJob', 'activate', 'cancel', 'destroyInstance']
    const missing = requiredFns.filter(fn => typeof binding[fn] !== 'function')
    if (missing.length > 0) {
      throw new Error(`Native binding missing functions: ${missing.join(', ')}. Rebuild prebuilds from the current branch.`)
    }
    console.log('[test] ✓ Binding API validated')

    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true })

    for (const name of MODEL_FILES) {
      const dest = path.join(modelDir, name)
      if (fs.existsSync(dest)) {
        console.log(`[test] ${name}: cached`)
        continue
      }
      await downloadFile(`${HF_BASE}/${name}`, dest, name)
    }

    const prepDest = path.join(modelDir, 'preprocessor.onnx')
    if (!fs.existsSync(prepDest)) {
      await downloadFile(PREPROCESSOR_URL, prepDest, 'preprocessor.onnx')
    } else {
      console.log('[test] preprocessor.onnx: cached')
    }

    let result = null
    let addonError = null
    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType: 'tdt',
      language: 'en',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('tdt', modelDir)
    }, (_, event, __, output, error) => {
      if (event === 'Output' && output) {
        const segments = Array.isArray(output) ? output : [output]
        for (const seg of segments) {
          if (seg?.text) result = seg.text
        }
      }
      if (error) {
        console.error('[test] Error:', error)
        addonError = error
      }
    })

    await parakeet.activate()

    await new Promise(r => setTimeout(r, 500))
    if (addonError) throw new Error(`ADDON_ERROR: ${addonError}`)

    console.log('[test] ✓ Model loaded')

    const audioPath = getAssetPath('sample.raw')
    if (!audioPath) throw new Error('sample.raw not found')

    const rawBuffer = fs.readFileSync(audioPath.replace('file://', ''))
    const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audio = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0

    console.log(`[test] Transcribing ${(audio.length / 16000).toFixed(1)}s audio...`)
    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    for (let i = 0; i < 60 && !result; i++) {
      await new Promise(r => setTimeout(r, 2000))
    }

    if (addonError) throw new Error(`ADDON_ERROR: ${addonError}`)
    if (!result || result.startsWith('[')) throw new Error(`No valid transcription result: "${result}"`)

    console.log(`[test] Result: "${result}"`)
    console.log(`[test] ✅ PASSED in ${((Date.now() - startTime) / 1000).toFixed(0)}s`)

    return {
      summary: { total: 1, passed: 1, failed: 0 },
      result: { fullText: result }
    }
  } catch (error) {
    console.error(`[test] ❌ FAILED: ${error.message}`)
    return { summary: { total: 1, passed: 0, failed: 1 }, output: error.message }
  } finally {
    try {
      if (parakeet) {
        await parakeet.destroyInstance()
      }
    } catch (_) {}
    try { if (binding) binding.releaseLogger() } catch (_) {}
  }
}

/**
 * Shared helper for model integration tests.
 *
 * @param {Object}   opts
 * @param {string}   opts.tag            - Log prefix, e.g. "test-ctc"
 * @param {string}   opts.dirPath        - Writable directory for cached models
 * @param {Function} opts.getAssetPath   - Resolves bundled test asset paths
 * @param {string}   opts.modelType      - "tdt" | "ctc" | "eou" | "sortformer"
 * @param {string}   opts.modelDirName   - Sub-directory name under dirPath
 * @param {Array}    opts.files          - Files to download: { name, url } or { name, url, skipRead }
 * @param {string}   [opts.action]       - Log description, defaults to "Transcribing"
 */
async function runModelTest (opts) {
  const { tag, dirPath, getAssetPath, modelType, modelDirName, files, action = 'Transcribing' } = opts
  const startTime = Date.now()
  const modelDir = path.join(dirPath, modelDirName)

  console.log(`[${tag}] Starting Parakeet ${modelType.toUpperCase()} test`)

  let binding = null
  let parakeet = null

  try {
    binding = require('@qvac/transcription-parakeet/binding.js')
    const { ParakeetInterface } = require('@qvac/transcription-parakeet/parakeet.js')
    binding.setLogger((p, m) => console.log(`[onnx:${p}] ${m}`))
    console.log(`[${tag}] ✓ Addon loaded`)

    const requiredFns = ['createInstance', 'runJob', 'activate', 'cancel', 'destroyInstance']
    const missing = requiredFns.filter(fn => typeof binding[fn] !== 'function')
    if (missing.length > 0) {
      throw new Error(`Native binding missing functions: ${missing.join(', ')}. Rebuild prebuilds from the current branch.`)
    }
    console.log(`[${tag}] ✓ Binding API validated`)

    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true })

    for (const file of files) {
      const dest = path.join(modelDir, file.name)
      if (fs.existsSync(dest)) {
        console.log(`[${tag}] ${file.name}: cached`)
        continue
      }
      await downloadFile(file.url, dest, file.name)
    }

    let result = null
    let addonError = null
    parakeet = new ParakeetInterface(binding, {
      modelPath: modelDir,
      modelType,
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig(modelType, modelDir)
    }, (_, event, __, output, error) => {
      if (event === 'Output' && output) {
        const segments = Array.isArray(output) ? output : [output]
        for (const seg of segments) {
          if (seg?.text) result = seg.text
        }
      }
      if (error) {
        console.error(`[${tag}] Error:`, error)
        addonError = error
      }
    })

    await parakeet.activate()

    await new Promise(r => setTimeout(r, 500))
    if (addonError) throw new Error(`ADDON_ERROR: ${addonError}`)

    console.log(`[${tag}] ✓ Model loaded`)

    const audioPath = getAssetPath('sample.raw')
    if (!audioPath) throw new Error('sample.raw not found')

    const rawBuffer = fs.readFileSync(audioPath.replace('file://', ''))
    const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audio = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0

    console.log(`[${tag}] ${action} ${(audio.length / 16000).toFixed(1)}s audio...`)
    await parakeet.append({ type: 'audio', data: audio.buffer })
    await parakeet.append({ type: 'end of job' })

    for (let i = 0; i < 60 && !result; i++) {
      await new Promise(r => setTimeout(r, 2000))
    }

    if (addonError) throw new Error(`ADDON_ERROR: ${addonError}`)
    if (!result || result.startsWith('[')) throw new Error(`No valid result: "${result}"`)

    console.log(`[${tag}] Result: "${result}"`)
    console.log(`[${tag}] ✅ PASSED in ${((Date.now() - startTime) / 1000).toFixed(0)}s`)

    return {
      summary: { total: 1, passed: 1, failed: 0 },
      result: { fullText: result }
    }
  } catch (error) {
    console.error(`[${tag}] ❌ FAILED: ${error.message}`)
    return { summary: { total: 1, passed: 0, failed: 1 }, output: error.message }
  } finally {
    try {
      if (parakeet) {
        await parakeet.destroyInstance()
      }
    } catch (_) {}
    try { if (binding) binding.releaseLogger() } catch (_) {}
  }
}

const CTC_HF_REPO = 'https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main'

async function _disabled_runCTCTranscriptionTest (dirPath, getAssetPath) { // eslint-disable-line no-unused-vars
  return runModelTest({
    tag: 'test-ctc',
    dirPath,
    getAssetPath,
    modelType: 'ctc',
    modelDirName: 'parakeet-ctc-model',
    files: [
      { name: 'model.onnx', url: `${CTC_HF_REPO}/onnx/model.onnx` },
      { name: 'model.onnx_data', url: `${CTC_HF_REPO}/onnx/model.onnx_data`, skipRead: true },
      { name: 'tokenizer.json', url: `${CTC_HF_REPO}/tokenizer.json` }
    ]
  })
}

const EOU_HF_BASE = 'https://huggingface.co/altunenes/parakeet-rs/resolve/main/realtime_eou_120m-v1-onnx'

async function _disabled_runEOUStreamingTest (dirPath, getAssetPath) { // eslint-disable-line no-unused-vars
  return runModelTest({
    tag: 'test-eou',
    dirPath,
    getAssetPath,
    modelType: 'eou',
    modelDirName: 'parakeet-eou-model',
    action: 'Transcribing (streaming)',
    files: [
      { name: 'encoder.onnx', url: `${EOU_HF_BASE}/encoder.onnx` },
      { name: 'decoder_joint.onnx', url: `${EOU_HF_BASE}/decoder_joint.onnx` },
      { name: 'tokenizer.json', url: `${EOU_HF_BASE}/tokenizer.json` }
    ]
  })
}

const SF_HF_BASE = 'https://huggingface.co/cgus/diar_streaming_sortformer_4spk-v2-onnx/resolve/main' // eslint-disable-line no-unused-vars

async function _disabled_runSortformerDiarizationTest (dirPath, getAssetPath) { // eslint-disable-line no-unused-vars
  return runModelTest({
    tag: 'test-sf',
    dirPath,
    getAssetPath,
    modelType: 'sortformer',
    modelDirName: 'sortformer-model',
    action: 'Running diarization on',
    files: [
      { name: 'sortformer.onnx', url: `${SF_HF_BASE}/diar_streaming_sortformer_4spk-v2.onnx` }
    ]
  })
}
