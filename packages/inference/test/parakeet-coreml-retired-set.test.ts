import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { models, type RegistryItem } from '@/models/registry/models'
import {
  clearRetiredCoremlSet,
  findCatalogCoremlCompanionSet,
  getCoremlSetKey,
  getRetiredCoremlSetDir,
  readRetiredCoremlCompanionSet
} from '@/handlers/load-model/coreml-sidecars'
import {
  getCoremlSidecarSpec,
  getModelCacheLayout,
  getRetiredCoremlSidecarSpec
} from '@/utils/cache/layout'
import { generateShortHash } from '@/utils/formatting'

const TDT_V3 = 'parakeet-tdt-0.6b-v3'
const UNIFIED = 'parakeet-unified-en-0.6b'
const ENCODER_ROOT = 'qvac_models_compiled/ggml/parakeet/2026-09-28/'

function catalogModel(filename: string): RegistryItem {
  const model = models.find((entry) => entry.registryPath.endsWith(`/${filename}`))
  if (!model) throw new Error(`${filename} is not in the catalog`)
  return model
}

/** The set directory an earlier release staged: the GGUF and its encoder bundle. */
function stageRetiredSet(cacheDir: string, model: RegistryItem): string {
  const setDir = getRetiredCoremlSetDir(model, 'darwin', cacheDir)!
  const filename = model.registryPath.split('/').pop()!
  fs.mkdirSync(path.join(setDir, `${TDT_V3}-encoder.mlmodelc`, 'weights'), { recursive: true })
  fs.writeFileSync(path.join(setDir, filename), 'gguf')
  fs.writeFileSync(path.join(setDir, `${TDT_V3}-encoder.mlmodelc`, 'weights', 'weight.bin'), 'w')
  return setDir
}

function tempCache(t: { teardown: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-retired-coreml-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('TDT v3 GGUFs load without the Core ML encoder on macOS and iOS', (t) => {
  for (const quant of ['f16', 'q4_0', 'q8_0']) {
    const model = catalogModel(`${TDT_V3}.${quant}.gguf`)
    for (const platform of ['darwin', 'ios']) {
      t.absent(
        getCoremlSidecarSpec(model.registryPath, model.registrySource, platform),
        `${quant} on ${platform} is not staged`
      )
      t.absent(findCatalogCoremlCompanionSet(model, platform))
    }
    const name = `${generateShortHash(model.registryPath)}_${TDT_V3}.${quant}.gguf`
    t.is(getModelCacheLayout(model, 'darwin', generateShortHash)?.path, name, 'single-file layout')
  }
})

test('Unified keeps its Core ML encoder', (t) => {
  const model = catalogModel(`${UNIFIED}.q8_0.gguf`)
  t.ok(getCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin'))
  t.absent(getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin'))
})

test('the retired TDT v3 set keeps the key the earlier release staged it under', (t) => {
  const model = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const spec = getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'ios')!
  t.ok(spec)
  t.is(spec.root, ENCODER_ROOT)
  t.alike(spec.bundles, [{ sourceName: `${TDT_V3}-encoder`, targetSuffix: '-encoder' }])
  // The set key the earlier release computed: shortHash(source:path:coreml:root).
  t.is(
    getCoremlSetKey(model, spec),
    generateShortHash(`s3:${model.registryPath}:coreml:${ENCODER_ROOT}`)
  )
  t.absent(getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'linux'))
  t.absent(getRetiredCoremlSetDir(model, 'android', '/cache'))
})

test('clearing a retired set keeps its GGUF as the single-file copy', async (t) => {
  const cacheDir = tempCache(t)
  const model = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const single = path.join(cacheDir, 'single.gguf')

  t.is(await clearRetiredCoremlSet(model, 'darwin', single, cacheDir), true)
  t.is(fs.readFileSync(single, 'utf8'), 'gguf', 'the GGUF moved')
  t.absent(fs.existsSync(setDir), 'the set and its bundle are gone')

  t.is(await clearRetiredCoremlSet(model, 'darwin', single, cacheDir), false, 'nothing left')
})

test('clearing a retired set leaves an existing single-file copy alone', async (t) => {
  const cacheDir = tempCache(t)
  const model = catalogModel(`${TDT_V3}.f16.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const single = path.join(cacheDir, 'single.gguf')
  fs.writeFileSync(single, 'already here')

  t.is(await clearRetiredCoremlSet(model, 'ios', single, cacheDir), true)
  t.is(fs.readFileSync(single, 'utf8'), 'already here')
  t.absent(fs.existsSync(setDir))
})

test('a retired set without its GGUF is still removed', async (t) => {
  const cacheDir = tempCache(t)
  const model = catalogModel(`${TDT_V3}.q4_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  fs.rmSync(path.join(setDir, `${TDT_V3}.q4_0.gguf`))
  const single = path.join(cacheDir, 'single.gguf')

  t.is(await clearRetiredCoremlSet(model, 'darwin', single, cacheDir), true)
  t.absent(fs.existsSync(single), 'the loader downloads the GGUF')
  t.absent(fs.existsSync(setDir))
})

test('clearing touches nothing off Apple or for a model whose set is current', async (t) => {
  const cacheDir = tempCache(t)
  const tdt = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, tdt)
  const single = path.join(cacheDir, 'single.gguf')
  for (const platform of ['linux', 'android', 'win32', undefined]) {
    t.is(await clearRetiredCoremlSet(tdt, platform, single, cacheDir), false, String(platform))
  }
  t.ok(fs.existsSync(setDir))

  const unified = catalogModel(`${UNIFIED}.q8_0.gguf`)
  const spec = getCoremlSidecarSpec(unified.registryPath, unified.registrySource, 'darwin')!
  const unifiedSet = path.join(cacheDir, 'sets', getCoremlSetKey(unified, spec))
  fs.mkdirSync(unifiedSet, { recursive: true })
  t.is(await clearRetiredCoremlSet(unified, 'darwin', single, cacheDir), false)
  t.ok(fs.existsSync(unifiedSet), "Unified's set is kept")
})

test("a retired set's metadata is read with the bundles that release staged", async (t) => {
  const cacheDir = tempCache(t)
  const model = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const spec = getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin')!
  const components = [
    'analytics/coremldata.bin',
    'coremldata.bin',
    'metadata.json',
    'model.mil',
    'weights/weight.bin'
  ]
  const file = (key: string, registryPath: string, targetName: string, size: number) => ({
    key,
    registryPath,
    registrySource: 's3',
    targetName,
    expectedSize: size,
    sha256Checksum: 'b'.repeat(64),
    blobCoreKey: 'core',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    primary: false
  })
  const set = {
    setKey: getCoremlSetKey(model, spec),
    primaryKey: 'modelPath',
    files: [
      {
        ...file('modelPath', model.registryPath, `${TDT_V3}.q8_0.gguf`, model.expectedSize),
        sha256Checksum: model.sha256Checksum,
        primary: true
      },
      ...components.map((component) =>
        file(
          `${TDT_V3}-encoder/${component}`,
          `${ENCODER_ROOT}${TDT_V3}-encoder.mlmodelc/${component}`,
          `${TDT_V3}-encoder.mlmodelc/${component}`,
          1
        )
      )
    ]
  }
  const setDir = path.join(cacheDir, 'sets', set.setKey)
  fs.mkdirSync(setDir, { recursive: true })
  fs.writeFileSync(path.join(setDir, '.coreml-companions.json'), JSON.stringify(set))

  const read = await readRetiredCoremlCompanionSet(model, 'darwin', cacheDir)
  t.is(read?.files.length, 6)
  t.absent(await readRetiredCoremlCompanionSet(model, 'linux', cacheDir))
})
