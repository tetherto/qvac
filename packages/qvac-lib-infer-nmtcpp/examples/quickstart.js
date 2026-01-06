'use strict'

// Note: This import will depend on the addon package installed
const TranslationNmtcpp = require('..')
const HyperdriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

const text = 'Machine translation has revolutionized how we communicate across language barriers in the modern digital world.'

async function testGGML () {
  console.log('\n=== Testing GGML Backend ===\n')

  // Create logger object
  const logger = {
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
    debug: (msg) => console.log('[DEBUG]', msg)
  }

  // 1. Create `DataLoader`
  const hdDL = new HyperdriveDL({
    // The hyperdrive key for en-it translation model weights and config
    key: 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f'
  })

  // 2. Create the `args` object
  const args = {
    loader: hdDL,
    params: { mode: 'full', dstLang: 'it', srcLang: 'en' },
    diskPath: './models',
    modelName: 'model.bin',
    logger // Pass the logger
  }

  // 4. Create Model Instance
  const model = new TranslationNmtcpp(args, { })

  // 5. Load model
  await model.load()

  try {
    // 6. Run the Model
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log(data)
      })
      .await()

    console.log('GGML translation finished!')
  } finally {
    // 7. Unload the model
    await model.unload()

    // Close the DataLoader
    await hdDL.close()
  }
}

async function testBergamot () {
  console.log('\n=== Testing Bergamot Backend ===\n')

  // Create logger object
  const logger = {
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
    debug: (msg) => console.log('[DEBUG]', msg)
  }

  // Use local model path for Bergamot - env var or relative path
  const bergamotPath = process.env.BERGAMOT_MODEL_PATH || './model/bergamot/enit'

  console.log('Model path:', bergamotPath)

  // Check if model directory exists
  if (!fs.existsSync(bergamotPath)) {
    console.log('Bergamot model directory not found, skipping test')
    console.log('Set BERGAMOT_MODEL_PATH env var or place model in ./model/bergamot/enit')
    return
  }

  console.log('Loading model...')

  // Create a local file loader for Bergamot models that are already on disk
  const localLoader = {
    ready: async () => { /* Models already on disk */ },
    close: async () => { /* No resources to close */ },
    download: async (filename) => {
      // Read file from local disk
      const filePath = path.join(bergamotPath, filename)
      return fs.readFileSync(filePath)
    },
    getFileSize: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      const stats = fs.statSync(filePath)
      return stats.size
    }
  }

  // Create the `args` object for Bergamot
  const args = {
    loader: localLoader,
    params: { mode: 'full', dstLang: 'it', srcLang: 'en' },
    diskPath: bergamotPath,
    modelName: 'model.enit.intgemm.alphas.bin',
    logger // Pass the logger
  }

  // Config with explicit vocab paths for Bergamot
  const config = {
    srcVocabName: 'vocab.enit.spm',
    dstVocabName: 'vocab.enit.spm',
    modelType: TranslationNmtcpp.ModelTypes.Bergamot
  }

  // Create Model Instance
  const model = new TranslationNmtcpp(args, config)

  // Load model
  await model.load()
  console.log('Model loaded successfully!')

  try {
    console.log('Running translation...')
    console.log('Input text:', text)

    // Run the Model
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log('Translation output:', data)
      })
      .await()

    console.log('Bergamot translation finished!')
  } finally {
    console.log('Unloading model...')
    await model.unload()

    // Close the local loader
    await localLoader.close()
    console.log('Done!')
  }
}

async function main () {
  try {
    // Test GGML backend
    await testGGML()

    // Test Bergamot backend
    await testBergamot()

    console.log('\n=== All Tests Completed Successfully! ===\n')
  } catch (error) {
    console.error('Test failed:', error)
    throw error
  }
}

main()
