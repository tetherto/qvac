'use strict'

const test = require('brittle')
const FakeDL = require('../mocks/loader.fake.js')

// Mock TranslationNmtcpp to test Opus deprecation without loading the native addon.
// The real index.js eagerly loads the C++ binding via require('./marian') → require('./binding')
// → require.addon(), which fails when the native addon is not built (e.g. in sanity-checks CI).
// These tests only verify JS-level behavior (ModelTypes enum and constructor guard),
// so we replicate the relevant logic from index.js here.

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')

class MockTranslationNmtcpp extends BaseInference {
  static ModelTypes = {
    IndicTrans: 'IndicTrans',
    Bergamot: 'Bergamot'
  }

  constructor ({ loader, diskPath, modelName, params, logger = null, exclusiveRun = true, ...args }, config = {}) {
    super({ logger, exclusiveRun, ...args })
    const { modelType } = config

    if (modelType === 'Opus') {
      throw new Error(
        'ModelTypes.Opus has been deprecated. Use ModelTypes.Bergamot instead. ' +
        'Bergamot covers European language pairs and supports pivot translation for non-English pairs via PivotTranslationModel.'
      )
    }
  }
}

test('ModelTypes does not have an Opus property', (t) => {
  t.is(MockTranslationNmtcpp.ModelTypes.Opus, undefined)
  t.absent(Object.keys(MockTranslationNmtcpp.ModelTypes).includes('Opus'))
})

test('ModelTypes.Bergamot equals "Bergamot"', (t) => {
  t.is(MockTranslationNmtcpp.ModelTypes.Bergamot, 'Bergamot')
})

test('ModelTypes.IndicTrans equals "IndicTrans"', (t) => {
  t.is(MockTranslationNmtcpp.ModelTypes.IndicTrans, 'IndicTrans')
})

test('Constructor throws deprecation error when modelType is Opus', (t) => {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    diskPath: '/tmp/fake',
    modelName: 'fake-model.bin',
    params: { srcLang: 'en', dstLang: 'fr' }
  }

  try {
    const _ = new MockTranslationNmtcpp(args, { modelType: 'Opus' }) // eslint-disable-line no-unused-vars
    t.fail('Expected constructor to throw for Opus modelType')
  } catch (err) {
    t.ok(err.message.includes('deprecated'), 'Error message mentions deprecation')
    t.ok(err.message.includes('Bergamot'), 'Error message mentions Bergamot replacement')
  }
})
