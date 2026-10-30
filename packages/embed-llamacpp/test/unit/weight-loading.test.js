'use strict'

const test = require('brittle')
const { GGMLBert, LayaDecisions, Reranker } = require('../../index.js')

const FIRST = '/models/model-00001-of-00003.gguf'

test('embedding, decision and reranking constructors reject streaming inputs', async function (t) {
  for (const Model of [GGMLBert, LayaDecisions, Reranker]) {
    for (const files of [[FIRST, '/models/model-00002-of-00003.gguf'], [new Uint8Array(8)]]) {
      await t.exception.all(
        () => new Model({ files: { model: files }, config: { device: 'cpu' } }),
        /streaming|buffers/
      )
    }
  }
})

test('embedding disk loading keeps the first path without sending buffers', async function (t) {
  const files = [FIRST]
  const model = new GGMLBert({ files: { model: files } })
  files.push('/models/model-00002-of-00003.gguf')
  model._createAddon = function (params) {
    t.is(params.path, FIRST)
    return {
      activate() {
        return Promise.resolve()
      },
      cancel() {
        return Promise.resolve()
      },
      unload() {
        return Promise.resolve()
      }
    }
  }
  await model.load()
  t.ok(model.getState().configLoaded)
  await model.unload()
})
