'use strict'

/**
 * Mobile Test Suite for @qvac/llm-llamacpp
 *
 * WARNING: This is a test file intended for internal mobile testing only.
 * It is NOT part of the public API and should NOT be used in production code.
 *
 * This file is included in the package to support the mobile testing framework.
 * The test functions and their interfaces may change without notice.
 *
 * Dependencies required to run this test (all in devDependencies):
 * - @qvac/dl-filesystem
 * - bare-fetch
 * - bare-fs
 */

const LlmLlamacpp = require('@qvac/llm-llamacpp')
const FilesystemDL = require('@qvac/dl-filesystem')
const path = require('bare-path')
const fetch = require('bare-fetch')
const fs = require('bare-fs')

// Module-level variables
let inference = null

/**
 * Downloads a file from a URL to a local path using bare-fetch
 * @param {string} url - The URL to download from
 * @param {string} destPath - The destination file path
 * @returns {Promise<void>}
 */
async function _downloadFile (url, destPath) {
  console.log(`Downloading from: ${url}`)
  console.log(`Saving to: ${destPath}`)

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`)
  }

  // Get the response as a buffer
  const buffer = await response.arrayBuffer()

  // Write to file
  fs.writeFileSync(destPath, Buffer.from(buffer))

  console.log(`Download complete: ${buffer.byteLength} bytes`)
}

let loader = null
/**
 * Main test function - runs a basic LLM inference test
 * @param {string} [dirPath=''] - Directory path for test assets (defaults to current directory)
 * @returns {Promise<string>}
 */
async function startTest (dirPath = '') {
  try {
    console.log('=== Starting LLM Mobile Test ===')
    console.log('Test assets directory:', dirPath)

    // Step 1: Download the model
    console.log('\n[1/5] Downloading model...')
    const modelName = 'stories260K.gguf'
    const modelUrl = 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'
    const modelPath = path.join(dirPath, modelName)

    // Check if model already exists
    if (!fs.existsSync(modelPath)) {
      await _downloadFile(modelUrl, modelPath)
    } else {
      console.log('Model already exists, skipping download')
    }
    console.log('✓ Model ready')

    // Step 2: Configure the model
    console.log('\n[2/5] Configuring LLM model...')
    loader = new FilesystemDL({ dirPath })
    const config = {
      gpu_layers: '99', // Use GPU - offload all layers to GPU
      ctx_size: '512', // Small context for faster testing
      predict: '64', // Limit prediction length
      device: 'gpu'
    }

    const args = {
      loader,
      modelName,
      logger: console,
      diskPath: dirPath,
      opts: { stats: false }
    }

    inference = new LlmLlamacpp(args, config)
    console.log('✓ Model configured')

    // Step 3: Load the model
    console.log('\n[3/5] Loading model weights...')
    console.log('Model file:', path.join(dirPath, modelName))
    await inference.load()
    console.log('✓ Model loaded successfully')

    // Step 4: Run inference with a simple prompt
    console.log('\n[4/5] Running inference...')
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: 'Give a one sentence story about a dog.'
      }
    ]

    const response = await inference.run(messages)
    console.log('✓ Inference started')

    // Collect the generated text
    let fullResponse = ''

    await response
      .onUpdate(data => {
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse)
    if (fullResponse.length === 0) {
      throw new Error('Model returned empty output')
    }

    // Step 5: Cleanup
    console.log('\n[5/5] Cleaning up...')
    await inference.destroy()
    inference = null
    await loader.close()
    loader = null
    console.log('✓ Cleanup completed')

    // Return success message
    return 'TEST COMPLETE ✓'
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    console.error('Stack trace:', error.stack)

    // Cleanup on error
    try {
      if (inference) {
        await inference.destroy()
        inference = null
      }
      if (loader) {
        await loader.close()
        loader = null
      }
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError)
    }

    throw new Error(`LLM Test Failed: ${error.message}`)
  }
}

let multimodalLoader = null
/**
 * Multimodal Test function - runs a vision/image description test
 * @param {string} [dirPath=''] - Directory path for test assets (defaults to current directory)
 * @param {Function} [getAssetPath=(name) => ''] - Function to get asset paths on mobile
 * @returns {Promise<string>}
 */
async function startMultimodalTest (dirPath = '', getAssetPath = (name) => '') {
  let multimodalInference = null

  try {
    console.log('=== Starting LLM Multimodal (Vision) Test ===')
    console.log('Test assets directory:', dirPath)

    // Step 1: Download the vision LLM model
    console.log('\n[1/6] Downloading vision LLM model...')
    const modelName = 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
    const modelUrl = 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
    const modelPath = path.join(dirPath, modelName)

    if (!fs.existsSync(modelPath)) {
      await _downloadFile(modelUrl, modelPath)
    } else {
      console.log('Vision LLM model already exists, skipping download')
    }
    console.log('✓ Vision LLM model ready')

    // Step 2: Download the projection model
    console.log('\n[2/6] Downloading projection model...')
    const projModelName = 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
    const projModelUrl = 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
    const projModelPath = path.join(dirPath, projModelName)

    if (!fs.existsSync(projModelPath)) {
      await _downloadFile(projModelUrl, projModelPath)
    } else {
      console.log('Projection model already exists, skipping download')
    }
    console.log('✓ Projection model ready')

    // Step 3: Get the test image path
    console.log('\n[3/6] Loading test image...')
    const imageFileName = 'news-paper.jpg'
    const imageFilePath = getAssetPath(imageFileName)
    console.log('✓ Image ready')

    // Step 4: Configure the model
    console.log('\n[4/6] Configuring vision LLM model...')
    multimodalLoader = new FilesystemDL({ dirPath })
    const config = {
      gpu_layers: '98', // Use GPU - offload layers to GPU
      ctx_size: '2048', // Context size
      device: 'gpu'
    }

    const args = {
      loader: multimodalLoader,
      modelName,
      logger: console,
      diskPath: dirPath,
      projectionPath: projModelPath, // Add projection model path
      opts: { stats: false }
    }

    multimodalInference = new LlmLlamacpp(args, config)
    console.log('✓ Vision model configured')

    // Step 5: Load the model
    console.log('\n[5/6] Loading vision model weights...')
    console.log('LLM Model file:', path.join(dirPath, modelName))
    console.log('Projection Model file:', projModelPath)
    await multimodalInference.load()
    console.log('✓ Vision model loaded successfully')

    // Step 6: Run inference with image
    console.log('\n[6/6] Running vision inference...')

    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
    console.log(`Image loaded: ${imageBytes.length} bytes`)

    // Prepare messages with image reference
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Describe the image briefly in one sentence.', image: imageBytes }
    ]

    const response = await multimodalInference.run(messages)
    console.log('✓ Inference started')

    // Collect the generated text
    let fullResponse = ''

    await response
      .onUpdate(data => {
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse)
    if (fullResponse.length === 0) {
      throw new Error('Model returned empty output')
    }

    // Cleanup
    console.log('\nCleaning up...')
    await multimodalInference.destroy()
    multimodalInference = null
    await multimodalLoader.close()
    multimodalLoader = null
    console.log('✓ Cleanup completed')

    // Return success message
    return 'MULTIMODAL TEST COMPLETE ✓'
  } catch (error) {
    console.error('\n❌ Multimodal test failed:', error)
    console.error('Stack trace:', error.stack)

    // Cleanup on error
    try {
      if (multimodalInference) {
        await multimodalInference.destroy()
        multimodalInference = null
      }
      if (multimodalLoader) {
        await multimodalLoader.close()
        multimodalLoader = null
      }
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError)
    }

    throw new Error(`LLM Multimodal Test Failed: ${error.message}`)
  }
}

// Export for potential direct use
module.exports = {
  startTest,
  startMultimodalTest
}
