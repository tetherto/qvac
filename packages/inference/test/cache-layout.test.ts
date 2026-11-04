import test from 'brittle'
import { models, type RegistryItem } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'
import { getModelCacheLayout } from '@/utils/cache/layout'
import {
  findCatalogCoremlCompanionSet,
  getCoremlSetKey,
  getCoremlSidecarSpec
} from '@/handlers/load-model/coreml-sidecars'

const catalog: readonly RegistryItem[] = models
const layoutOf = (model: RegistryItem, platform: string) =>
  getModelCacheLayout(model, platform, generateShortHash)

test('a single-file model is <shortHash(registryPath)>_<filename>', (t) => {
  const model = catalog.find(
    (entry) =>
      !entry.companionSet &&
      !getCoremlSidecarSpec(entry.registryPath, entry.registrySource, 'darwin')
  )!
  const name = `${generateShortHash(model.registryPath)}_${model.registryPath.split('/').pop()}`
  t.alike(layoutOf(model, 'linux'), {
    path: name,
    files: [{ path: name, size: model.expectedSize, sha256: model.sha256Checksum }]
  })
})

test('a sharded model has no layout before download', (t) => {
  const model = { ...catalog[0]!, registryPath: 'x/big-00001-of-00004.gguf' }
  t.is(layoutOf(model, 'linux'), undefined)
})

test('a companion set is its set directory with every file of the set', (t) => {
  const model = catalog.find((entry) => entry.companionSet)!
  const layout = layoutOf(model, 'linux')!
  const setKey = model.companionSet!.setKey
  t.is(layout.path, `sets/${setKey}`)
  t.alike(
    layout.files,
    model.companionSet!.files.map((file) => ({
      path: `sets/${setKey}/${file.targetName}`,
      size: file.expectedSize,
      sha256: file.sha256Checksum
    }))
  )
})

test('a Core ML model on darwin is the set the loader builds from the catalog', (t) => {
  const coreml = catalog.filter((entry) => findCatalogCoremlCompanionSet(entry, 'darwin'))
  t.ok(coreml.length > 0, 'the catalog has Core ML models')
  for (const model of coreml) {
    const set = findCatalogCoremlCompanionSet(model, 'darwin')!
    const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin')!
    t.is(set.setKey, getCoremlSetKey(model, spec))
    t.alike(layoutOf(model, 'darwin'), {
      path: `sets/${set.setKey}`,
      files: set.files.map((file) => ({
        path: `sets/${set.setKey}/${file.targetName}`,
        size: file.expectedSize,
        sha256: file.sha256Checksum
      }))
    })
    t.not(layoutOf(model, 'linux')?.path, `sets/${set.setKey}`, 'no Core ML set off Apple')
  }
})

test('a Core ML model whose bundles the catalog lacks has no layout on darwin', (t) => {
  const { companionSet: _companionSet, ...base } = catalog[0]!
  const model: RegistryItem = {
    ...base,
    registrySource: 'hf',
    registryPath:
      'qvac/TranscribePsy-250M-EU-sub-coreml/resolve/unknown/transcribepsy-250m-eu-sub-coreml.gguf'
  }
  t.is(layoutOf(model, 'darwin'), undefined, 'the loader asks the live registry')
  t.is(layoutOf(model, 'linux')?.files.length, 1, 'a single file elsewhere')
})
