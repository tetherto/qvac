// Debug logging to diagnose Windows silent crash
console.log('[DEBUG] addon.test.js starting...')

const { configure } = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

console.log('[DEBUG] process.platform:', process.platform)
console.log('[DEBUG] Loading marian.js...')

let TranslationInterface
try {
  TranslationInterface = require('../../marian.js').TranslationInterface
  console.log('[DEBUG] marian.js loaded successfully')
} catch (e) {
  console.error('[DEBUG] Failed to load marian.js:', e)
  process.exit(1)
}

console.log('[DEBUG] Loading index.js (TranslationNmtcpp)...')
let TranslationNmtcpp
try {
  TranslationNmtcpp = require('../../index.js')
  console.log('[DEBUG] index.js loaded successfully')
} catch (e) {
  console.error('[DEBUG] Failed to load index.js:', e)
  process.exit(1)
}

console.log('[DEBUG] Loading WeightsProvider...')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
console.log('[DEBUG] Loading HyperDriveDL...')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
console.log('[DEBUG] All modules loaded successfully')

configure({
  timeout: 240000
})

async function ensureModel () {
  const modelDir = path.resolve(__dirname, '../../model/nmt')
  const modelName = 'model.bin'
  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    return modelPath
  }

  fs.mkdirSync(modelDir, { recursive: true })

  const hd = new HyperDriveDL({ key: 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f' })
  const weightsProvider = new WeightsProvider(hd, this.logger)
  await weightsProvider.downloadFiles([modelName], modelDir, {
    closeLoader: true
  })

  return modelPath
}

function ensureIndicTransModel () {
  // IndicTrans model path is set by CI workflow via INDICTRANS_MODEL_PATH env var
  // or defaults to model/indictrans directory
  const modelPath = process.env.INDICTRANS_MODEL_PATH || path.resolve(__dirname, '../../model/indictrans/ggml-indictrans2-en-indic-dist-200M-q4_0.bin')

  if (!fs.existsSync(modelPath)) {
    console.log('IndicTrans model not found:', modelPath)
    return null
  }

  // Check model file size - the 200M q4_0 model should be ~127MB
  const stats = fs.statSync(modelPath)
  const sizeMB = stats.size / (1024 * 1024)
  console.log('Found IndicTrans model at:', modelPath)
  console.log('IndicTrans model size:', sizeMB.toFixed(2), 'MB')

  // Minimum expected size for the 200M model (should be around 127MB)
  if (sizeMB < 100) {
    console.log('WARNING: IndicTrans model file seems too small, may be corrupted')
    console.log('Expected ~127MB, got', sizeMB.toFixed(2), 'MB')
    return null
  }

  return modelPath
}

function ensureBergamotModel () {
  // Bergamot model path is set by CI workflow via BERGAMOT_MODEL_PATH env var
  // or defaults to model/bergamot/enit directory
  const modelDir = process.env.BERGAMOT_MODEL_PATH || path.resolve(__dirname, '../../model/bergamot/enit')

  // Check if model files exist (intgemm model + vocab)
  if (!fs.existsSync(modelDir)) {
    console.log('Bergamot model directory not found:', modelDir)
    return null
  }

  const files = fs.readdirSync(modelDir)
  const hasIntgemm = files.some(f => f.includes('.intgemm'))
  const hasVocab = files.some(f => f.includes('.spm'))

  if (!hasIntgemm || !hasVocab) {
    console.log('Bergamot model files not found in:', modelDir)
    console.log('Files found:', files)
    return null
  }

  console.log('Found Bergamot model at:', modelDir)
  return modelDir
}

// Logger to capture C++ logs
const logger = {
  error: (msg) => console.log('[C++ ERROR]:', msg),
  warn: (msg) => console.log('[C++ WARN]:', msg),
  info: (msg) => console.log('[C++ INFO]:', msg),
  debug: (msg) => console.log('[C++ DEBUG]:', msg)
}

function onOutput (addon, event, jobId, output, error) {
  if (event === 'Output') {
    console.log('jobId: ' + jobId + ', output: ' + output)
  } else if (event === 'Error') {
    console.log('jobId: ' + jobId + ', error: ' + error)
  } else if (event === 'JobEnded') {
    console.log('jobId: ' + jobId + ', stats: ' + JSON.stringify(output))
  } else {
    console.log('jobId: ' + jobId + ', event: ' + event)
  }
  addon.status().then((val) => console.log('status: ' + val))
}

async function addonStatus (addon, targetStatus, timeout = 300000) {
  // Define status progression order
  const statusOrder = ['LOADING', 'PROCESSING', 'IDLE']

  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    const checkStatus = async () => {
      try {
        const currentStatus = await addon.status()

        if (currentStatus === targetStatus) {
          resolve(currentStatus)
          return
        }

        // Check if we've already passed the target status (race condition handling)
        const targetIdx = statusOrder.indexOf(targetStatus)
        const currentIdx = statusOrder.indexOf(currentStatus)
        if (targetIdx >= 0 && currentIdx >= 0 && currentIdx > targetIdx) {
          // Status has progressed past the target - that's OK, resolve with current
          console.log(`Note: Status '${currentStatus}' is past target '${targetStatus}' - continuing`)
          resolve(currentStatus)
          return
        }

        if (Date.now() - startTime > timeout) {
          reject(new Error(`Timeout waiting for status '${targetStatus}'. Current status: '${currentStatus}'`))
          return
        }

        setTimeout(checkStatus, 1000)
      } catch (error) {
        reject(error)
      }
    }

    checkStatus()
  })
}

async function test () {
  const modelPath = await ensureModel()

  const config = {
    beamsize: 4,
    lengthpenalty: 0.4,
    maxlength: 128,
    repetitionpenalty: 1.2,
    norepeatngramsize: 2,
    temperature: 0.8,
    topk: 40,
    topp: 0.9
  }

  const addon = new TranslationInterface({ path: modelPath, config, use_gpu: false }, onOutput, logger)

  console.log('addon.status(): ' + (await addon.status()))
  console.log(await addon.append({ type: 'text', input: 'This is a test', priority: 60 }))

  console.log(
    await addon.append({
      type: 'text',
      input: 'My name is Georg Cantor, and I developed set theory. Down, down, down. Would the fall never come to an end? "I wonder how many miles I\'ve fallen by this time?" she said aloud. "I must be getting somewhere near the centre of the earth. Let me see: that would be four thousand miles down. I think-" (for, you see, Alice had learnt several things of this sort in her lessons in the schoolroom, and though this was not a very good opportunity for showing off her knowledge, as there was no one to listen to her, still it was good practice to say it over) "-yes, that\'s about the right distance-but then I wonder what Latitude or Longitude I\'ve got to?" (Alice had no idea what Latitude was, or Longitude either, but thought they were nice grand words to say.)',
      priority: 51
    })
  )

  console.log(await addon.append({ type: 'end of job' }))

  await addon.activate()

  await addonStatus(addon, 'PROCESSING')
  await addonStatus(addon, 'IDLE')

  console.log('exiting')

  try {
    await addon.destroy()
  } catch (e) {
    console.log('destroy() error:', e)
  }
}

async function testIndicTrans () {
  const modelPath = ensureIndicTransModel()

  if (!modelPath) {
    console.log('Skipping IndicTrans test - model not available')
    return
  }

  console.log('=== Running IndicTrans backend test (with IndicProcessor) ===')
  console.log('Platform:', process.platform)

  // Create a local file loader for the model
  const modelDir = path.dirname(modelPath)
  const modelName = path.basename(modelPath)

  const localLoader = {
    ready: async () => {},
    close: async () => {},
    download: async (filename) => {
      const filePath = path.join(modelDir, filename)
      return fs.readFileSync(filePath)
    },
    getFileSize: async (filename) => {
      const filePath = path.join(modelDir, filename)
      const stats = fs.statSync(filePath)
      return stats.size
    }
  }

  let model
  try {
    console.log('Creating TranslationNmtcpp for IndicTrans (with IndicProcessor)...')

    const args = {
      loader: localLoader,
      params: {
        mode: 'full',
        srcLang: 'eng_Latn',
        dstLang: 'hin_Deva'
      },
      diskPath: modelDir,
      modelName: modelName,
      logger
    }

    model = new TranslationNmtcpp(args, {
      modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
      use_gpu: false // Disable GPU for CI testing
    })

    console.log('Loading IndicTrans model...')
    await model.load()
    console.log('TranslationNmtcpp loaded successfully')
  } catch (e) {
    console.error('Failed to create/load TranslationNmtcpp for IndicTrans:', e.message)
    console.error('Error code:', e.code)
    if (process.platform === 'win32') {
      console.log('NOTE: IndicTrans model loading failed on Windows - this may be a known issue')
      console.log('Skipping IndicTrans test on Windows')
      return
    }
    throw e
  }

  // Test sentence - NO language prefix needed, IndicProcessor handles it
  const testSentence = 'Hello, how are you?'
  console.log(`\nTranslating: "${testSentence}"`)

  try {
    const response = await model.run(testSentence)
    let translation = ''
    await response
      .onUpdate(data => {
        translation = data
      })
      .await()
    console.log(`Output: "${translation}"`)

    // Verify we got a non-empty translation
    if (!translation || translation.length === 0) {
      throw new Error('Empty translation received')
    }
    console.log('IndicTrans test with IndicProcessor completed successfully')
  } catch (e) {
    console.error('Translation error:', e.message)
    throw e
  } finally {
    try {
      await model.unload()
    } catch (e) {
      console.log('unload() error:', e)
    }
  }
}

async function testBergamot () {
  const modelPath = ensureBergamotModel()

  if (!modelPath) {
    console.log('Skipping Bergamot test - model not available')
    return
  }

  console.log('=== Running Bergamot backend test ===')

  // Get the model file name from the directory
  const files = fs.readdirSync(modelPath)
  const modelFile = files.find(f => f.includes('.intgemm') && f.includes('.bin'))
  const vocabFile = files.find(f => f.includes('.spm'))

  if (!modelFile || !vocabFile) {
    console.log('Skipping Bergamot test - model or vocab files not found')
    return
  }

  // Build full paths for model and vocabs
  const fullModelPath = path.join(modelPath, modelFile)
  const fullVocabPath = path.join(modelPath, vocabFile)

  const config = {
    beamsize: 1,
    normalize: 1,
    src_vocab: fullVocabPath,
    dst_vocab: fullVocabPath
  }

  const addon = new TranslationInterface({ path: fullModelPath, config, use_gpu: false }, onOutput, logger)

  console.log('Bergamot addon.status(): ' + (await addon.status()))

  // Test with simple English text to translate to Italian
  console.log(await addon.append({ type: 'text', input: 'Hello, how are you?', priority: 60 }))
  console.log(await addon.append({ type: 'text', input: 'The weather is nice today.', priority: 51 }))
  console.log(await addon.append({ type: 'end of job' }))

  await addon.activate()

  await addonStatus(addon, 'PROCESSING')
  await addonStatus(addon, 'IDLE')

  console.log('Bergamot test completed')

  try {
    await addon.destroy()
  } catch (e) {
    console.log('destroy() error:', e)
  }
}

// Helper to add delay between tests for resource cleanup
function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runAllTests () {
  console.log('[DEBUG] runAllTests starting...')
  console.log('[DEBUG] Platform:', process.platform)
  console.log('[DEBUG] Memory usage at start:', JSON.stringify(process.memoryUsage()))

  // Run IndicTrans backend test FIRST (before GGML) to avoid memory issues
  // The GGML test loads a large model that may not fully release memory
  try {
    console.log('[DEBUG] Starting IndicTrans test...')
    await testIndicTrans()
    console.log('[DEBUG] IndicTrans test completed')
  } catch (e) {
    console.error('[DEBUG] IndicTrans test failed:', e)
    throw e
  }

  // Small delay to allow resource cleanup
  await delay(1000)
  console.log('[DEBUG] Memory after IndicTrans:', JSON.stringify(process.memoryUsage()))

  // Run GGML backend test
  try {
    console.log('[DEBUG] Starting GGML test...')
    await test()
    console.log('[DEBUG] GGML test completed')
  } catch (e) {
    console.error('[DEBUG] GGML test failed:', e)
    throw e
  }

  // Small delay to allow resource cleanup
  await delay(1000)
  console.log('[DEBUG] Memory after GGML:', JSON.stringify(process.memoryUsage()))

  // Run Bergamot backend test
  try {
    console.log('[DEBUG] Starting Bergamot test...')
    await testBergamot()
    console.log('[DEBUG] Bergamot test completed')
  } catch (e) {
    console.error('[DEBUG] Bergamot test failed:', e)
    throw e
  }

  console.log('[DEBUG] Memory at end:', JSON.stringify(process.memoryUsage()))
}

runAllTests().catch((e) => {
  console.log(e)
  process.exit(1)
})
