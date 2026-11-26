import test from 'brittle'
import { generateModelsFileContent } from '@/models/update-models/codegen'
import { groupCompanionSets } from '@/models/update-models/companions'
import type { ProcessedModel } from '@/models/update-models/types'

function model(overrides: Partial<ProcessedModel> = {}): ProcessedModel {
  return {
    registryPath: 'org/model/model.gguf',
    registrySource: 'hf',
    blobCoreKey: 'ab',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    modelId: 'model.gguf',
    addon: 'llm',
    expectedSize: 1,
    sha256Checksum: 'cd',
    engine: 'llamacpp-completion',
    modelName: 'model',
    quantization: 'Q4_K_M',
    params: '7B',
    tags: [],
    ...overrides
  }
}

function catalogModels(source: string): Array<Record<string, string>> {
  const match = source.match(/export const models = (\[[\s\S]*\n\]) as const satisfies/)
  if (!match?.[1]) throw new Error('models array missing')
  return Function(`"use strict"; return (${match[1]})`)() as Array<Record<string, string>>
}

test('codegen emits registry strings as data', (t) => {
  const quantization = '"); throw new Error("pwned"); //'
  const params = 'a\nb"c\\d'
  const registrySource = 'src"; evil'
  const registryPath = 'path`${x}`'
  const modelId = 'id"\n'
  const output = generateModelsFileContent([
    model({ quantization, params, registrySource, registryPath, modelId })
  ])

  const models = catalogModels(output)
  const entry = models[0]
  if (!entry) throw new Error('catalog entry missing')

  t.is(entry.quantization, quantization)
  t.is(entry.params, params)
  t.is(entry.registrySource, registrySource)
  t.is(entry.registryPath, registryPath)
  t.is(entry.modelId, modelId)
  t.is(entry.engine, 'llamacpp-completion')
})

test('codegen keeps all TranscribePsy EU Core ML components distinct and private', (t) => {
  const root = 'qvac_models_compiled/ggml/transcribe-psy/2026-11-25/'
  const bundles = [
    ['decoder', 'DECODER'],
    ['encoder-shared', 'ENCODER_SHARED']
  ] as const
  const components = [
    ['analytics/coremldata.bin', 'ANALYTICS_COREMLDATA_BIN'],
    ['coremldata.bin', 'COREMLDATA_BIN'],
    ['model.mil', 'MODEL_MIL'],
    ['weights/weight.bin', 'WEIGHTS_WEIGHT_BIN']
  ] as const
  const paths = bundles.flatMap(([bundle]) =>
    components.map(([file]) => `${root}transcribepsy-250m-eu-${bundle}.mlmodelc/${file}`)
  )
  const primary = model({
    registryPath: 'qvac_models_compiled/ggml/transcribepsy/2026-11-09/transcribepsy-250m-eu.gguf',
    registrySource: 's3',
    modelId: 'transcribepsy-250m-eu.gguf',
    addon: 'parakeet',
    engine: 'parakeet-transcription',
    quantization: 'q8_0',
    params: '250M'
  })
  const grouped = groupCompanionSets([
    primary,
    ...paths.map((registryPath) => model({ ...primary, registryPath, quantization: '' }))
  ])
  const output = generateModelsFileContent(grouped)

  t.alike(
    catalogModels(output).map((entry) => entry.registryPath),
    [primary.registryPath, ...paths]
  )
  t.alike(
    catalogModels(output)
      .slice(1)
      .map((entry) => entry.name),
    bundles.flatMap(([, bundleName]) =>
      components.map(([, fileName]) => `PARAKEET_TRANSCRIBEPSY_250M_EU_${bundleName}_${fileName}`)
    )
  )
  t.alike(
    [...output.matchAll(/^export const (PARAKEET_\w+) =/gm)].map((match) => match[1]),
    ['PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0']
  )
})

test('codegen catalogs Core ML source-package files without public model exports', (t) => {
  const paths = [
    'acestep/vae-decoder.mlpackage/Manifest.json',
    'acestep/vae-decoder.mlpackage/Data/com.apple.CoreML/model.mlmodel',
    'acestep/vae-decoder.mlpackage/Data/com.apple.CoreML/weights/weight.bin'
  ]
  const primary = model({
    registryPath: 'acestep/acestep-v15-turbo-F16.gguf',
    modelId: 'acestep-v15-turbo-F16.gguf',
    addon: 'audiogen',
    engine: 'audiogen-ggml'
  })
  const grouped = groupCompanionSets([
    primary,
    ...paths.map((registryPath) =>
      model({ registryPath, addon: 'audiogen', engine: 'audiogen-ggml' })
    )
  ])
  const output = generateModelsFileContent(grouped)

  t.alike(
    catalogModels(output).map((entry) => entry.registryPath),
    [primary.registryPath, ...paths]
  )
  t.is(
    (output.match(/export const \w+ = \{/g) || []).length,
    1,
    'only the GGUF has a public constant'
  )
  t.absent(output.includes('export const AUDIOGEN_MANIFEST ='))
  t.absent(output.includes('export const AUDIOGEN_MODEL ='))
})
