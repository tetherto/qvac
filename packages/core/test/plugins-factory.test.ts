import test from 'brittle'
import { plugins, clearPlugins, getAllPlugins, hasPlugin } from '../src/plugins'
import { ModelType } from '../src/schemas'
import { PluginDefinitionInvalidError } from '../src/utils/errors-server'
import type { QvacPlugin } from '../src/schemas/plugin'
import { makeFakePlugin } from './fixtures/fake-plugin'

test('plugins([]) returns the host API without registering anything', function (t) {
  clearPlugins()
  try {
    const core = plugins([])
    t.is(getAllPlugins().length, 0, 'no plugins registered')
    t.is(typeof core.translate, 'function', 'host API exposes translate')
    t.is(typeof core.completion, 'function', 'host API exposes completion')
    t.is(typeof core.loadModel, 'function', 'host API exposes loadModel')
  } finally {
    clearPlugins()
  }
})

test('plugins([one]) registers the plugin and returns the host API', function (t) {
  clearPlugins()
  try {
    const core = plugins([makeFakePlugin(ModelType.nmtcppTranslation)])
    t.ok(hasPlugin(ModelType.nmtcppTranslation), 'plugin registered')
    t.is(getAllPlugins().length, 1)
    t.is(typeof core.translate, 'function')
  } finally {
    clearPlugins()
  }
})

test('plugins([many]) registers all provided plugins', function (t) {
  clearPlugins()
  try {
    plugins([
      makeFakePlugin(ModelType.nmtcppTranslation),
      makeFakePlugin(ModelType.llamacppCompletion),
      makeFakePlugin(ModelType.llamacppEmbedding)
    ])
    t.is(getAllPlugins().length, 3, 'all three registered')
    t.ok(hasPlugin(ModelType.nmtcppTranslation))
    t.ok(hasPlugin(ModelType.llamacppCompletion))
    t.ok(hasPlugin(ModelType.llamacppEmbedding))
  } finally {
    clearPlugins()
  }
})

test('plugins([invalid]) throws a validation error (fail-fast)', function (t) {
  clearPlugins()
  try {
    const invalid = {
      modelType: 'broken',
      displayName: '',
      addonPackage: '@qvac/fake-broken',
      createModel() {
        return { model: { load: async function () {} } }
      },
      handlers: {}
    } as unknown as QvacPlugin

    try {
      plugins([invalid])
      t.fail('expected plugins() to throw')
    } catch (err) {
      t.ok(err instanceof PluginDefinitionInvalidError, 'throws PluginDefinitionInvalidError')
    }
  } finally {
    clearPlugins()
  }
})
