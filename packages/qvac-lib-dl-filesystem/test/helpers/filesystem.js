'use strict'

const path = require('bare-path')
const fs = require('bare-fs')

/**
 * Creates a realistic filesystem test structure with various file types and directory structures
 * @param {Object} options - Configuration options
 * @param {string} options.basePath - Base directory path where test data will be created
 * @param {boolean} [options.createModel=true] - Whether to create model directory structure
 * @param {boolean} [options.createDeepStructure=true] - Whether to create deep directory structure
 * @param {boolean} [options.createSpecialFiles=true] - Whether to create files with special names
 * @param {number} [options.deepLevels=10] - Number of deep directory levels to create
 * @param {number} [options.shardCount=3] - Number of model shard files to create
 * @param {number} [options.modelSize=1024*1024] - Size of model.bin file in bytes
 * @param {number} [options.shardSize=1024*512] - Size of each shard file in bytes
 * @returns {Object} - Information about created files and directories
 */
function createRealisticTestData (options = {}) {
  const {
    basePath,
    createModel = true,
    createDeepStructure = true,
    createSpecialFiles = true,
    deepLevels = 10,
    shardCount = 3,
    modelSize = 1024 * 1024,
    shardSize = 1024 * 512
  } = options

  if (!basePath) {
    throw new Error('basePath is required')
  }

  const createdFiles = []
  const createdDirs = []

  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true })
    createdDirs.push(basePath)
  }

  if (createModel) {
    const modelDir = path.join(basePath, 'model')
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir)
      createdDirs.push(modelDir)
    }

    const configPath = path.join(modelDir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({
      model_type: 'whisper',
      vocab_size: 51865,
      max_sequence_length: 1024,
      num_layers: 12,
      hidden_size: 768
    }, null, 2))
    createdFiles.push(configPath)

    const tokenizerPath = path.join(modelDir, 'tokenizer.json')
    const tokenizerData = {
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [
        { id: 50257, content: '<|endoftext|>', single_word: false },
        { id: 50258, content: '<|startoftranscript|>', single_word: false },
        { id: 50259, content: '<|endoftranscript|>', single_word: false }
      ],
      normalizer: {
        type: 'Lowercase'
      },
      pre_tokenizer: {
        type: 'Whitespace'
      }
    }
    fs.writeFileSync(tokenizerPath, JSON.stringify(tokenizerData, null, 2))
    createdFiles.push(tokenizerPath)

    const modelPath = path.join(modelDir, 'model.bin')
    const weightData = Buffer.alloc(modelSize)
    for (let i = 0; i < weightData.length; i += 4) {
      weightData.writeFloatLE(Math.random() * 2 - 1, i)
    }
    fs.writeFileSync(modelPath, weightData)
    createdFiles.push(modelPath)

    const weightsDir = path.join(modelDir, 'weights')
    if (!fs.existsSync(weightsDir)) {
      fs.mkdirSync(weightsDir)
      createdDirs.push(weightsDir)
    }

    for (let i = 0; i < shardCount; i++) {
      const shardPath = path.join(weightsDir, `shard_${i}.bin`)
      const shardData = Buffer.alloc(shardSize)
      for (let j = 0; j < shardData.length; j += 4) {
        shardData.writeFloatLE(Math.sin(j * 0.001) * Math.random(), j)
      }
      fs.writeFileSync(shardPath, shardData)
      createdFiles.push(shardPath)
    }

    const vocabPath = path.join(modelDir, 'vocab.txt')
    const vocabContent = Array.from({ length: 1000 }, (_, i) => `token_${i}`).join('\n')
    fs.writeFileSync(vocabPath, vocabContent)
    createdFiles.push(vocabPath)
  }

  if (createDeepStructure) {
    const deepDir = path.join(basePath, 'deep')
    let currentPath = deepDir
    for (let i = 0; i < deepLevels; i++) {
      currentPath = path.join(currentPath, `level${i}`)
      if (!fs.existsSync(currentPath)) {
        fs.mkdirSync(currentPath, { recursive: true })
        createdDirs.push(currentPath)
      }
    }

    const deepFilePath = path.join(currentPath, 'deep_file.txt')
    fs.writeFileSync(deepFilePath, 'deeply nested content with some additional text to make it more realistic')
    createdFiles.push(deepFilePath)

    for (let i = 0; i < Math.min(deepLevels, 5); i++) {
      const levelPath = path.join(deepDir, ...Array.from({ length: i + 1 }, (_, j) => `level${j}`))
      const levelFilePath = path.join(levelPath, `level_${i}_file.txt`)
      fs.writeFileSync(levelFilePath, `Content for level ${i}`)
      createdFiles.push(levelFilePath)
    }
  }

  if (createSpecialFiles) {
    const specialFiles = [
      { name: 'empty.bin', content: '' },
      { name: 'special chars & spaces.txt', content: 'special content with symbols !@#$%^&*()' },
      { name: '.hidden', content: 'hidden file content' },
      { name: '.env', content: 'NODE_ENV=test\nDEBUG=true' },
      { name: 'файл.txt', content: 'unicode content with cyrillic' },
      { name: '🎉test.txt', content: 'emoji content 🚀' },
      { name: 'very-long-filename-that-tests-filesystem-limits-and-edge-cases.txt', content: 'long filename content' }
    ]

    for (const file of specialFiles) {
      const filePath = path.join(basePath, file.name)
      fs.writeFileSync(filePath, file.content)
      createdFiles.push(filePath)
    }

    const largePath = path.join(basePath, 'large.txt')
    const largeContent = Array.from({ length: 10000 }, (_, i) => `Line ${i}: This is a large file for testing streaming capabilities.`).join('\n')
    fs.writeFileSync(largePath, largeContent)
    createdFiles.push(largePath)

    const binaryPath = path.join(basePath, 'binary.bin')
    const binaryData = Buffer.alloc(1024)
    for (let i = 0; i < binaryData.length; i++) {
      binaryData[i] = i % 256
    }
    fs.writeFileSync(binaryPath, binaryData)
    createdFiles.push(binaryPath)
  }

  return {
    basePath,
    createdFiles,
    createdDirs,
    summary: {
      totalFiles: createdFiles.length,
      totalDirs: createdDirs.length,
      hasModel: createModel,
      hasDeepStructure: createDeepStructure,
      hasSpecialFiles: createSpecialFiles
    }
  }
}

/**
 * Removes all test data created by createRealisticTestData
 * @param {string} basePath - Base directory path to remove
 */
function cleanupTestData (basePath) {
  if (!basePath) {
    throw new Error('basePath is required')
  }

  if (fs.existsSync(basePath)) {
    fs.rmSync(basePath, { recursive: true, force: true })
  }
}

module.exports = {
  createRealisticTestData,
  cleanupTestData
}
