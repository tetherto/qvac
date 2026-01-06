'use strict'

const test = require('brittle')
const FakeDL = require('../mocks/loader.fake')
const GGMLBert = require('../../index')
const MockedBinding = require('../mocks/MockedBinding')
const { BertInterface } = require('../../addon')

const process = require('process')
global.process = process
const sinon = require('sinon')

const text = 'test input text'

test('can get inference output for the input and finish processing', async t => {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: { mode: 'full' },
    opts: {},
    modelName: 'fakeModel-00001-of-00005.gguf'
  }
  const config = {}
  const model = new GGMLBert(args, config)

  sinon.stub(model, '_createAddon').callsFake(configParams => {
    const binding = new MockedBinding()
    return new BertInterface(binding, configParams, model._outputCallback.bind(model), console.log)
  })

  await model.load()
  const response = await model.run([{ content: text, role: 'user' }])
  response.onUpdate(data => {
    t.alike(data, 'mock response')
  })
  t.ok(await response.await())
})
