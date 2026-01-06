#!/usr/bin/env bare
'use strict'

const binding = require('./binding')
const fs = require('bare-fs')
const path = require('bare-path') // eslint-disable-line no-unused-vars

// Create temporary test directory
const testDir = '/tmp/bergamot-validation-test'
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true })
}

console.log('Testing Bergamot file validation...\n')

// Test 1: Model file not found
console.log('Test 1: Model file not found')
try {
  const model1 = new binding.TranslationModel('bergamot')
  model1.load({
    model_path: '/nonexistent/model.bin',
    src_vocab_path: path.join(testDir, 'vocab.spm'),
    dst_vocab_path: path.join(testDir, 'vocab.spm')
  })
  console.log('  ❌ FAILED: Expected error for non-existent model')
} catch (e) {
  console.log('  ✓ PASSED: Correctly rejected non-existent model')
  console.log('   ', e.message)
}

// Test 2: Model wrong extension
console.log('\nTest 2: Model wrong extension')
const wrongModelPath = path.join(testDir, 'model.gz')
fs.writeFileSync(wrongModelPath, 'dummy data')
try {
  const model2 = new binding.TranslationModel('bergamot')
  model2.load({
    model_path: wrongModelPath,
    src_vocab_path: path.join(testDir, 'vocab.spm'),
    dst_vocab_path: path.join(testDir, 'vocab.spm')
  })
  console.log('  ❌ FAILED: Expected error for wrong model extension')
} catch (e) {
  console.log('  ✓ PASSED: Correctly rejected wrong model extension')
  console.log('   ', e.message)
}

// Test 3: Vocab file not found
console.log('\nTest 3: Vocab file not found')
const validModelPath = path.join(testDir, 'model.bin')
fs.writeFileSync(validModelPath, 'dummy model data')
try {
  const model3 = new binding.TranslationModel('bergamot')
  model3.load({
    model_path: validModelPath,
    src_vocab_path: '/nonexistent/vocab.spm',
    dst_vocab_path: '/nonexistent/vocab.spm'
  })
  console.log('  ❌ FAILED: Expected error for non-existent vocab')
} catch (e) {
  console.log('  ✓ PASSED: Correctly rejected non-existent vocab')
  console.log('   ', e.message)
}

// Test 4: Vocab wrong extension
console.log('\nTest 4: Vocab wrong extension')
const wrongVocabPath = path.join(testDir, 'vocab.txt')
fs.writeFileSync(wrongVocabPath, 'dummy vocab data')
try {
  const model4 = new binding.TranslationModel('bergamot')
  model4.load({
    model_path: validModelPath,
    src_vocab_path: wrongVocabPath,
    dst_vocab_path: wrongVocabPath
  })
  console.log('  ❌ FAILED: Expected error for wrong vocab extension')
} catch (e) {
  console.log('  ✓ PASSED: Correctly rejected wrong vocab extension')
  console.log('   ', e.message)
}

// Test 5: Empty paths
console.log('\nTest 5: Empty model path')
try {
  const model5 = new binding.TranslationModel('bergamot')
  model5.load({
    model_path: '',
    src_vocab_path: path.join(testDir, 'vocab.spm'),
    dst_vocab_path: path.join(testDir, 'vocab.spm')
  })
  console.log('  ❌ FAILED: Expected error for empty model path')
} catch (e) {
  console.log('  ✓ PASSED: Correctly rejected empty model path')
  console.log('   ', e.message)
}

// Cleanup
console.log('\nCleaning up test directory...')
try {
  if (fs.existsSync(testDir)) {
    const files = fs.readdirSync(testDir)
    for (const file of files) {
      fs.unlinkSync(path.join(testDir, file))
    }
    fs.rmdirSync(testDir)
  }
} catch (e) {
  console.log('Cleanup skipped:', e.message)
}

console.log('\n✅ All validation tests completed!')
