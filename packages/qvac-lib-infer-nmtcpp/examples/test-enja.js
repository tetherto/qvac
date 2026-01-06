'use strict'

const TranslationNmtcpp = require('..')

const text = 'Hello, how are you today?'

async function main () {
  // Create logger object
  const logger = {
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
    debug: (msg) => console.log('[DEBUG]', msg)
  }

  // Path to enja model directory
  const modelPath = '/tmp/bergamot-asian-test/enja'

  // Create a minimal local file loader for Bergamot models that are already on disk
  const localLoader = {
    ready: async () => { /* Models already on disk */ },
    close: async () => { /* No resources to close */ }
  }

  // Create the `args` object for Bergamot backend
  const args = {
    loader: localLoader,
    params: { mode: 'full', dstLang: 'ja', srcLang: 'en' },
    diskPath: modelPath,
    modelName: '', // Empty for Bergamot - it uses the directory
    logger // Pass the logger
  }

  console.log('Creating model instance for enja (English-Japanese) Bergamot backend...')
  console.log('Model path:', modelPath)

  // Create Model Instance
  const model = new TranslationNmtcpp(args, {})

  console.log('Loading model...')
  try {
    // Load model - backend will be auto-detected based on model files
    await model.load()
    console.log('Model loaded successfully!')

    console.log('Running translation...')
    console.log('Input text:', text)

    // Run the Model
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log('Translation output:', data)
      })
      .await()

    console.log('Translation finished!')
  } catch (err) {
    console.error('Error:', err)
    console.error('Stack:', err.stack)
  } finally {
    console.log('Unloading model...')
    // Unload the model
    await model.unload()

    // Close the loader
    await localLoader.close()
    console.log('Done!')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  console.error('Stack:', err.stack)
  throw err
})
