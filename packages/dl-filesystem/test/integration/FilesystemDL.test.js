'use strict'
const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const FilesystemDL = require('../..')
const { createRealisticTestData, cleanupTestData } = require('../helpers/filesystem')

const INTEGRATION_TEST_DIR = path.join(__dirname, 'real_filesystem_test')

let testFixture

test.hook('setup', (t) => {
  testFixture = createRealisticTestData({
    basePath: INTEGRATION_TEST_DIR,
    createModel: true,
    createDeepStructure: true,
    createSpecialFiles: true,
    deepLevels: 10,
    shardCount: 3,
    modelSize: 1024 * 1024,
    shardSize: 1024 * 512
  })

  t.ok(fs.existsSync(testFixture.basePath), 'Base directory should exist')
  t.is(testFixture.summary.totalFiles > 0, true, 'Should have created files')
  t.is(testFixture.summary.totalDirs > 0, true, 'Should have created directories')
  t.is(testFixture.summary.hasModel, true, 'Should have model structure')
  t.is(testFixture.summary.hasDeepStructure, true, 'Should have deep structure')
  t.is(testFixture.summary.hasSpecialFiles, true, 'Should have special files')

  const modelPath = path.join(INTEGRATION_TEST_DIR, 'model')
  t.ok(fs.existsSync(modelPath), 'Model directory should exist')
  t.ok(fs.existsSync(path.join(modelPath, 'config.json')), 'Config file should exist')
  t.ok(fs.existsSync(path.join(modelPath, 'tokenizer.json')), 'Tokenizer file should exist')
  t.ok(fs.existsSync(path.join(modelPath, 'model.bin')), 'Model binary should exist')
  t.ok(fs.existsSync(path.join(modelPath, 'weights')), 'Weights directory should exist')
  t.ok(fs.existsSync(path.join(modelPath, 'vocab.txt')), 'Vocab file should exist')

  const deepPath = path.join(INTEGRATION_TEST_DIR, 'deep/level0/level1/level2/level3/level4/level5/level6/level7/level8/level9')
  t.ok(fs.existsSync(deepPath), 'Deep directory structure should exist')
  t.ok(fs.existsSync(path.join(deepPath, 'deep_file.txt')), 'Deep file should exist')

  t.ok(fs.existsSync(path.join(INTEGRATION_TEST_DIR, 'empty.bin')), 'Empty file should exist')
  t.ok(fs.existsSync(path.join(INTEGRATION_TEST_DIR, 'special chars & spaces.txt')), 'Special chars file should exist')
  t.ok(fs.existsSync(path.join(INTEGRATION_TEST_DIR, '.hidden')), 'Hidden file should exist')
  t.ok(fs.existsSync(path.join(INTEGRATION_TEST_DIR, 'large.txt')), 'Large file should exist')
  t.ok(fs.existsSync(path.join(INTEGRATION_TEST_DIR, 'binary.bin')), 'Binary file should exist')
})

test('FilesystemDL Integration: should handle real model loading workflow', async (t) => {
  const modelPath = path.join(INTEGRATION_TEST_DIR, 'model')
  const fsDL = new FilesystemDL({ dirPath: modelPath })

  const files = await fsDL.list()

  t.ok(files.includes('config.json'), 'Can list actual config file')
  t.ok(files.includes('tokenizer.json'), 'Can list actual tokenizer file')
  t.ok(files.includes('model.bin'), 'Can list actual model file')
  t.ok(files.includes('weights'), 'Can list weights directory')

  const configStream = await fsDL.getStream('config.json')
  let configData = ''
  for await (const chunk of configStream) {
    configData += chunk.toString()
  }

  const config = JSON.parse(configData)
  t.is(config.model_type, 'whisper', 'Config contains real model type')
  t.is(config.vocab_size, 51865, 'Config contains real vocab size')

  const weightsStream = await fsDL.getStream('model.bin')
  let weightsSize = 0
  let firstChunk = null

  for await (const chunk of weightsStream) {
    weightsSize += chunk.length
    if (!firstChunk) firstChunk = chunk
  }

  t.is(weightsSize, 1024 * 1024, 'Model weights have expected size')
  t.ok(firstChunk.length > 0, 'Model weights contain actual data')

  const weightFiles = await fsDL.list('weights')
  t.is(weightFiles.length, 3, 'Weights directory contains expected shards')

  const shard0Stream = await fsDL.getStream('weights/shard_0.bin')
  let shard0Size = 0
  for await (const chunk of shard0Stream) {
    shard0Size += chunk.length
  }
  t.is(shard0Size, 1024 * 512, 'Individual shard has expected size')
})

test('FilesystemDL Integration: should handle real filesystem edge cases', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: INTEGRATION_TEST_DIR })

  const specialFiles = await fsDL.list()
  t.ok(specialFiles.includes('special chars & spaces.txt'), 'Handles files with special characters')

  const specialStream = await fsDL.getStream('special chars & spaces.txt')
  let specialContent = ''
  for await (const chunk of specialStream) {
    specialContent += chunk.toString()
  }
  t.is(specialContent, 'special content with symbols !@#$%^&*()', 'Correctly reads files with special names')

  t.ok(specialFiles.includes('.hidden'), 'Can access hidden files')

  const emptyStream = await fsDL.getStream('empty.bin')
  const emptyChunks = []
  for await (const chunk of emptyStream) {
    emptyChunks.push(chunk)
  }
  t.is(emptyChunks.length, 0, 'Empty files produce no chunks')
})

test('FilesystemDL Integration: should handle deep directory traversal', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: INTEGRATION_TEST_DIR })

  const deepPath = 'deep/level0/level1/level2/level3/level4/level5/level6/level7/level8/level9'

  const deepFiles = await fsDL.list(deepPath)
  t.ok(deepFiles.includes('deep_file.txt'), 'Can access deeply nested files')

  const deepStream = await fsDL.getStream(`${deepPath}/deep_file.txt`)
  let deepContent = ''
  for await (const chunk of deepStream) {
    deepContent += chunk.toString()
  }
  t.is(deepContent, 'deeply nested content with some additional text to make it more realistic', 'Can read deeply nested file content')
})

test('FilesystemDL Integration: should handle concurrent access to real files', async (t) => {
  const modelPath = path.join(INTEGRATION_TEST_DIR, 'model')
  const fsDL = new FilesystemDL({ dirPath: modelPath })

  const operations = [
    fsDL.getStream('config.json'),
    fsDL.getStream('tokenizer.json'),
    fsDL.getStream('model.bin'),
    fsDL.list(),
    fsDL.list('weights')
  ]

  const results = await Promise.all(operations)

  t.ok(results[0], 'Config stream opened successfully')
  t.ok(results[1], 'Tokenizer stream opened successfully')
  t.ok(results[2], 'Model stream opened successfully')
  t.ok(Array.isArray(results[3]), 'Root directory listed successfully')
  t.ok(Array.isArray(results[4]), 'Weights directory listed successfully')

  const sameFileOperations = [
    fsDL.getStream('model.bin'),
    fsDL.getStream('model.bin'),
    fsDL.getStream('model.bin')
  ]

  const sameFileResults = await Promise.all(sameFileOperations)
  t.is(sameFileResults.length, 3, 'Multiple concurrent streams to same file work')
})

test('FilesystemDL Integration: should handle real performance scenarios', async (t) => {
  const modelPath = path.join(INTEGRATION_TEST_DIR, 'model')
  const fsDL = new FilesystemDL({ dirPath: modelPath })

  const startTime = Date.now()
  const modelStream = await fsDL.getStream('model.bin')

  let totalSize = 0
  let chunkCount = 0

  for await (const chunk of modelStream) {
    totalSize += chunk.length
    chunkCount++
  }

  const endTime = Date.now()
  const duration = endTime - startTime

  t.is(totalSize, 1024 * 1024, 'Streamed expected amount of data')
  t.ok(chunkCount > 0, 'File was streamed in chunks')
  t.ok(duration < 1000, 'Large file streaming completed in reasonable time')

  const files = await fsDL.list('weights')
  const rapidStartTime = Date.now()

  for (const file of files) {
    const stream = await fsDL.getStream(`weights/${file}`)
    let size = 0
    for await (const chunk of stream) {
      size += chunk.length
    }
    t.is(size, 1024 * 512, `${file} has expected size`)
  }

  const rapidEndTime = Date.now()
  const rapidDuration = rapidEndTime - rapidStartTime

  t.ok(rapidDuration < 500, 'Rapid file access completed in reasonable time')
})

test('FilesystemDL Integration: should handle large binary file streaming efficiently', async (t) => {
  const modelPath = path.join(INTEGRATION_TEST_DIR, 'model')
  const fsDL = new FilesystemDL({ dirPath: modelPath })

  const stream = await fsDL.getStream('model.bin')

  let processedBytes = 0
  let maxChunkSize = 0
  let chunkCount = 0
  const totalChunks = []

  for await (const chunk of stream) {
    processedBytes += chunk.length
    maxChunkSize = Math.max(maxChunkSize, chunk.length)
    chunkCount++
    totalChunks.push(chunk)
  }

  t.is(processedBytes, 1024 * 1024, 'Processed all binary data')
  t.ok(chunkCount > 1, 'File was streamed in multiple chunks')
  t.ok(maxChunkSize < 1024 * 1024, 'Individual chunks are smaller than full file')
  t.ok(totalChunks.length === chunkCount, 'All chunks were processed correctly')

  // Verify that streaming doesn't load entire file into memory at once
  const averageChunkSize = processedBytes / chunkCount
  t.ok(averageChunkSize < 1024 * 512, 'Average chunk size is reasonable for streaming')
})

test('FilesystemDL Integration: should handle complex directory structures', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: INTEGRATION_TEST_DIR })

  const rootFiles = await fsDL.list()
  t.ok(rootFiles.includes('model'), 'Root contains model directory')
  t.ok(rootFiles.includes('deep'), 'Root contains deep directory structure')
  t.ok(rootFiles.includes('empty.bin'), 'Root contains empty binary file')
  t.ok(rootFiles.includes('.hidden'), 'Root contains hidden file')

  const modelFiles = await fsDL.list('model')
  t.ok(modelFiles.includes('config.json'), 'Model directory contains config')
  t.ok(modelFiles.includes('tokenizer.json'), 'Model directory contains tokenizer')
  t.ok(modelFiles.includes('model.bin'), 'Model directory contains weights')
  t.ok(modelFiles.includes('weights'), 'Model directory contains weights subdirectory')

  const weightsFiles = await fsDL.list('model/weights')
  t.is(weightsFiles.length, 3, 'Weights directory contains correct number of shards')
  t.ok(weightsFiles.every(file => file.startsWith('shard_')), 'All weight files follow expected naming pattern')
})

test.hook('teardown', (t) => {
  cleanupTestData(INTEGRATION_TEST_DIR)

  t.ok(!fs.existsSync(INTEGRATION_TEST_DIR), 'Test directory should be removed')
})
