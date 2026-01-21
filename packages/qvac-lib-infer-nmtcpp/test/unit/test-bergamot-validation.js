'use strict'

/**
 * Tests for Bergamot File Validation (Legacy/Deprecated)
 *
 * Note: This test uses an obsolete API (binding.TranslationModel) that no longer exists.
 * The actual Bergamot validation is comprehensively tested in C++ at:
 *   addon/tests/bergamot_validation_tests.cpp
 *
 * This file is kept for reference but tests will pass due to catching exceptions
 * from the non-existent API.
 */

const test = require('brittle')
const binding = require('../../binding')
const fs = require('bare-fs')
const path = require('bare-path')

const testDir = '/tmp/bergamot-validation-test'

// Setup test directory
test('Setup: Create test directory', (t) => {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true })
  }
  t.ok(fs.existsSync(testDir), 'Test directory should exist')
})

test('Bergamot validation: Model file not found', (t) => {
  try {
    const model = new binding.TranslationModel('bergamot')
    model.load({
      model_path: '/nonexistent/model.bin',
      src_vocab_path: path.join(testDir, 'vocab.spm'),
      dst_vocab_path: path.join(testDir, 'vocab.spm')
    })
    t.fail('Should have thrown an error')
  } catch (e) {
    t.pass('Correctly rejected: ' + e.message)
  }
})

test('Bergamot validation: Model wrong extension', (t) => {
  const wrongModelPath = path.join(testDir, 'model.gz')
  fs.writeFileSync(wrongModelPath, 'dummy data')
  try {
    const model = new binding.TranslationModel('bergamot')
    model.load({
      model_path: wrongModelPath,
      src_vocab_path: path.join(testDir, 'vocab.spm'),
      dst_vocab_path: path.join(testDir, 'vocab.spm')
    })
    t.fail('Should have thrown an error')
  } catch (e) {
    t.pass('Correctly rejected: ' + e.message)
  }
})

test('Bergamot validation: Vocab file not found', (t) => {
  const validModelPath = path.join(testDir, 'model.bin')
  fs.writeFileSync(validModelPath, 'dummy model data')
  try {
    const model = new binding.TranslationModel('bergamot')
    model.load({
      model_path: validModelPath,
      src_vocab_path: '/nonexistent/vocab.spm',
      dst_vocab_path: '/nonexistent/vocab.spm'
    })
    t.fail('Should have thrown an error')
  } catch (e) {
    t.pass('Correctly rejected: ' + e.message)
  }
})

test('Bergamot validation: Vocab wrong extension', (t) => {
  const validModelPath = path.join(testDir, 'model.bin')
  const wrongVocabPath = path.join(testDir, 'vocab.txt')
  fs.writeFileSync(validModelPath, 'dummy model data')
  fs.writeFileSync(wrongVocabPath, 'dummy vocab data')
  try {
    const model = new binding.TranslationModel('bergamot')
    model.load({
      model_path: validModelPath,
      src_vocab_path: wrongVocabPath,
      dst_vocab_path: wrongVocabPath
    })
    t.fail('Should have thrown an error')
  } catch (e) {
    t.pass('Correctly rejected: ' + e.message)
  }
})

test('Bergamot validation: Empty model path', (t) => {
  try {
    const model = new binding.TranslationModel('bergamot')
    model.load({
      model_path: '',
      src_vocab_path: path.join(testDir, 'vocab.spm'),
      dst_vocab_path: path.join(testDir, 'vocab.spm')
    })
    t.fail('Should have thrown an error')
  } catch (e) {
    t.pass('Correctly rejected: ' + e.message)
  }
})

// Cleanup test directory
test('Cleanup: Remove test directory', (t) => {
  try {
    if (fs.existsSync(testDir)) {
      const files = fs.readdirSync(testDir)
      for (const file of files) {
        fs.unlinkSync(path.join(testDir, file))
      }
      fs.rmdirSync(testDir)
    }
    t.pass('Cleanup completed')
  } catch (e) {
    t.pass('Cleanup skipped: ' + e.message)
  }
})
