import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { withCoremlLongFormDefault } from '@/plugins/builtin/asr-ggml/coreml-long-form'
import { parakeetFitRequest } from '@/plugins/builtin/asr-ggml/fit'
import { parakeetLoadEngineConfig } from '@/plugins/builtin/parakeet-transcription/plugin'
import type { ParakeetConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/schemas/plugin'

const TDT_V3 = 'parakeet-tdt-0.6b-v3'
const UNIFIED = 'parakeet-unified-en-0.6b'

/**
 * A model directory as the loader stages it: the GGUF, and with `bundle` its
 * `<stem>-encoder.mlmodelc` directory beside it. Returns the GGUF path.
 */
function stage(
  t: { teardown: (fn: () => void) => void },
  gguf: string,
  bundle: string | undefined
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-parakeet-long-form-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, gguf), 'gguf')
  if (bundle !== undefined) {
    const bundleDir = path.join(dir, bundle)
    fs.mkdirSync(bundleDir)
    fs.writeFileSync(path.join(bundleDir, 'coremldata.bin'), 'bundle')
  }
  return path.join(dir, gguf)
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('TDT v3 with its Core ML encoder staged defaults to one ggml pass on macOS and iOS', (t) => {
  for (const quant of ['f16', 'q4_0', 'q8_0']) {
    const modelPath = stage(t, `${TDT_V3}.${quant}.gguf`, `${TDT_V3}-encoder.mlmodelc`)
    for (const platform of ['darwin', 'ios']) {
      const config = withCoremlLongFormDefault({ useGPU: true }, modelPath, platform)
      t.is(config.longFormWindowFrames, -1, `${quant} on ${platform}`)
      t.is(config.useGPU, true, 'other fields are kept')
      t.absent(config.longFormContextFrames, 'the context is left to the engine')
    }
  }
})

test('a long-form window the caller set is kept', (t) => {
  const modelPath = stage(t, `${TDT_V3}.q8_0.gguf`, `${TDT_V3}-encoder.mlmodelc`)
  for (const longFormWindowFrames of [0, 375, -1]) {
    const config = withCoremlLongFormDefault({ longFormWindowFrames }, modelPath, 'darwin')
    t.is(config.longFormWindowFrames, longFormWindowFrames, `${longFormWindowFrames} is kept`)
  }
})

test('without a staged encoder bundle the config is unchanged', (t) => {
  const bare = stage(t, `${TDT_V3}.q8_0.gguf`, undefined)
  const input: ParakeetConfig = { useGPU: false }
  t.is(withCoremlLongFormDefault(input, bare, 'darwin'), input, 'GGUF alone')

  // Another model's bundle, or a file where the bundle directory goes, is not
  // the bundle the engine loads.
  const otherBundle = stage(t, `${TDT_V3}.q8_0.gguf`, `${UNIFIED}-encoder.mlmodelc`)
  t.is(withCoremlLongFormDefault(input, otherBundle, 'darwin'), input, "another stem's bundle")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-parakeet-long-form-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, `${TDT_V3}.q8_0.gguf`), 'gguf')
  fs.writeFileSync(path.join(dir, `${TDT_V3}-encoder.mlmodelc`), 'not a bundle')
  t.is(
    withCoremlLongFormDefault(input, path.join(dir, `${TDT_V3}.q8_0.gguf`), 'darwin'),
    input,
    'a file named like the bundle'
  )

  t.is(withCoremlLongFormDefault(input, '', 'darwin'), input, 'no model path')
  t.is(withCoremlLongFormDefault(input, undefined, 'darwin'), input, 'undefined model path')
})

test('off Apple platforms the config is unchanged', (t) => {
  const modelPath = stage(t, `${TDT_V3}.q8_0.gguf`, `${TDT_V3}-encoder.mlmodelc`)
  const input: ParakeetConfig = {}
  for (const platform of ['linux', 'android', 'win32', undefined]) {
    t.is(withCoremlLongFormDefault(input, modelPath, platform), input, String(platform))
  }
})

test('other Parakeet models with a staged encoder keep the engine default', (t) => {
  const stems = [
    UNIFIED,
    'diar_streaming_sortformer_4spk-v2.1',
    'parakeet_realtime_eou_120m-v1',
    'parakeet-tdt-0.6b-v2'
  ]
  for (const stem of stems) {
    const modelPath = stage(t, `${stem}.q8_0.gguf`, `${stem}-encoder.mlmodelc`)
    const input: ParakeetConfig = {}
    t.is(withCoremlLongFormDefault(input, modelPath, 'darwin'), input, stem)
  }
  // A GGUF name that only contains the TDT v3 stem is another model.
  const prefixed = stage(t, `my-${TDT_V3}.q8_0.gguf`, `my-${TDT_V3}-encoder.mlmodelc`)
  t.is(withCoremlLongFormDefault({}, prefixed, 'darwin').longFormWindowFrames, undefined)
})

test('the bundle is checked through the injected probe at the path the engine loads', (t) => {
  const probed: string[] = []
  const config = withCoremlLongFormDefault(
    {},
    '/models/sets/abc/parakeet-tdt-0.6b-v3-q4_0.gguf',
    'ios',
    (bundlePath) => {
      probed.push(bundlePath)
      return true
    }
  )
  t.alike(probed, ['/models/sets/abc/parakeet-tdt-0.6b-v3-encoder.mlmodelc'])
  t.is(config.longFormWindowFrames, -1)
})

test('the load hands the addon the defaulted window', (t) => {
  const modelPath = stage(t, `${TDT_V3}.q8_0.gguf`, `${TDT_V3}-encoder.mlmodelc`)

  const staged = parakeetLoadEngineConfig({ modelPath, modelConfig: { useGPU: true } }, 'darwin')
  t.is(staged.engine, 'parakeet')
  t.is(staged.parakeetConfig.longFormWindowFrames, -1)
  t.is(staged.parakeetConfig.useGPU, true)

  const explicit = parakeetLoadEngineConfig(
    { modelPath, modelConfig: { longFormWindowFrames: 0 } },
    'darwin'
  )
  t.is(explicit.parakeetConfig.longFormWindowFrames, 0, 'the caller value reaches the addon')

  const linux = parakeetLoadEngineConfig({ modelPath, modelConfig: {} }, 'linux')
  t.absent('longFormWindowFrames' in linux.parakeetConfig, 'no change off Apple')
})

test('the fit request projects the same encoder pass the load runs', (t) => {
  const modelPath = stage(t, `${TDT_V3}.q8_0.gguf`, `${TDT_V3}-encoder.mlmodelc`)
  const load = (modelConfig: unknown) => ({ modelPath, modelConfig, isShardedModel: false })

  t.is(requestOf(parakeetFitRequest(load({}), 'darwin'))?.['longFormWindowFrames'], -1)
  t.is(
    requestOf(parakeetFitRequest(load({ longFormWindowFrames: 375 }), 'ios'))?.[
      'longFormWindowFrames'
    ],
    375
  )
  t.absent('longFormWindowFrames' in (requestOf(parakeetFitRequest(load({}), 'linux')) ?? {}))
})
