'use strict'

const test = require('brittle')
const TranslationNmtcpp = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')

test('ModelTypes does not have an Opus property', (t) => {
  t.is(TranslationNmtcpp.ModelTypes.Opus, undefined)
  t.absent(Object.keys(TranslationNmtcpp.ModelTypes).includes('Opus'))
})

test('ModelTypes.Bergamot equals "Bergamot"', (t) => {
  t.is(TranslationNmtcpp.ModelTypes.Bergamot, 'Bergamot')
})

test('ModelTypes.IndicTrans equals "IndicTrans"', (t) => {
  t.is(TranslationNmtcpp.ModelTypes.IndicTrans, 'IndicTrans')
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
    const _ = new TranslationNmtcpp(args, { modelType: 'Opus' }) // eslint-disable-line no-unused-vars
    t.fail('Expected constructor to throw for Opus modelType')
  } catch (err) {
    t.ok(err.message.includes('deprecated'), 'Error message mentions deprecation')
    t.ok(err.message.includes('Bergamot'), 'Error message mentions Bergamot replacement')
  }
})
