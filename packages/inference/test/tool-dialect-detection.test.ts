import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Buffer from 'bare-buffer'
import { z } from 'zod'
import { ARCHITECTURE_SCAN_BYTES, readGgufArchitecture } from '@/utils/gguf-architecture'
import {
  matchToolDialectFromArchitecture,
  matchToolDialectFromName,
  resolveToolDialect
} from '@/utils/tools'
import { detectToolDialect } from '@/utils/tool-integration'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { loadModel } from '@/plugins/ops/load-model'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { unregisterModel } from '@/runtime/model-registry'

type Value =
  | { type: 'string'; value: string }
  | { type: 'u32'; value: number }
  | { type: 'strings'; value: string[] }
  | { type: 'f32s'; count: number }

function u32(value: number, bigEndian: boolean) {
  const b = Buffer.alloc(4)
  if (bigEndian) b.writeUInt32BE(value, 0)
  else b.writeUInt32LE(value, 0)
  return b
}

function u64(value: number, bigEndian: boolean) {
  const b = Buffer.alloc(8)
  if (bigEndian) b.writeBigUInt64BE(BigInt(value), 0)
  else b.writeBigUInt64LE(BigInt(value), 0)
  return b
}

function str(value: string, bigEndian: boolean) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([u64(bytes.length, bigEndian), bytes])
}

function encodeValue(value: Value, bigEndian: boolean) {
  switch (value.type) {
    case 'string':
      return Buffer.concat([u32(8, bigEndian), str(value.value, bigEndian)])
    case 'u32':
      return Buffer.concat([u32(4, bigEndian), u32(value.value, bigEndian)])
    case 'strings':
      return Buffer.concat([
        u32(9, bigEndian),
        u32(8, bigEndian),
        u64(value.value.length, bigEndian),
        ...value.value.map((s) => str(s, bigEndian))
      ])
    case 'f32s':
      return Buffer.concat([
        u32(9, bigEndian),
        u32(6, bigEndian),
        u64(value.count, bigEndian),
        Buffer.alloc(value.count * 4)
      ])
  }
}

function gguf(kvs: Array<[string, Value]>, opts: { bigEndian?: boolean } = {}) {
  const bigEndian = opts.bigEndian ?? false
  return Buffer.concat([
    Buffer.from('GGUF'),
    u32(3, bigEndian),
    u64(0, bigEndian),
    u64(kvs.length, bigEndian),
    ...kvs.map(([key, value]) =>
      Buffer.concat([str(key, bigEndian), encodeValue(value, bigEndian)])
    )
  ])
}

function tempFile(t: { teardown(fn: () => void): void }, name: string, bytes: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-dialect-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, name)
  fs.writeFileSync(file, bytes)
  return file
}

const arch = (value: string): [string, Value] => ['general.architecture', { type: 'string', value }]

test('readGgufArchitecture: reads general.architecture written first', async (t) => {
  const file = tempFile(
    t,
    'model.gguf',
    gguf([arch('qwen35'), ['general.name', { type: 'string', value: 'x' }]])
  )
  t.is(await readGgufArchitecture(file), 'qwen35')
})

test('readGgufArchitecture: skips earlier keys of every value shape', async (t) => {
  const vocab = Array.from({ length: 20_000 }, (_, i) => `token-${i}`)
  const file = tempFile(
    t,
    'model.gguf',
    gguf([
      ['general.alignment', { type: 'u32', value: 32 }],
      ['tokenizer.ggml.tokens', { type: 'strings', value: vocab }],
      ['tokenizer.ggml.scores', { type: 'f32s', count: 20_000 }],
      arch('gemma4')
    ])
  )
  t.is(await readGgufArchitecture(file), 'gemma4')
})

test('readGgufArchitecture: reads a big-endian header', async (t) => {
  const file = tempFile(t, 'model.gguf', gguf([arch('lfm2')], { bigEndian: true }))
  t.is(await readGgufArchitecture(file), 'lfm2')
})

test('readGgufArchitecture: does not read past the scan window', async (t) => {
  const file = tempFile(
    t,
    'model.gguf',
    gguf([
      ['tokenizer.ggml.scores', { type: 'f32s', count: ARCHITECTURE_SCAN_BYTES / 4 }],
      arch('qwen35')
    ])
  )
  t.is(await readGgufArchitecture(file), undefined)
})

test('readGgufArchitecture: undefined for a header without the key', async (t) => {
  const file = tempFile(t, 'model.gguf', gguf([['general.name', { type: 'string', value: 'x' }]]))
  t.is(await readGgufArchitecture(file), undefined)
})

test('readGgufArchitecture: undefined for unreadable files', async (t) => {
  const notGguf = tempFile(t, 'model.bin', Buffer.from('not a gguf file at all'))
  t.is(await readGgufArchitecture(notGguf), undefined, 'wrong magic')

  const bigEndian = gguf([arch('lfm2')], { bigEndian: true })
  const swappedMagic = tempFile(
    t,
    'swapped.gguf',
    Buffer.concat([Buffer.from('FUGG'), Buffer.from(bigEndian.subarray(4))])
  )
  t.is(await readGgufArchitecture(swappedMagic), undefined, 'byte-swapped magic')

  const full = gguf([['general.name', { type: 'string', value: 'name' }], arch('qwen35')])
  const truncated = tempFile(t, 'cut.gguf', Buffer.from(full.subarray(0, full.length - 4)))
  t.is(await readGgufArchitecture(truncated), undefined, 'truncated header')

  const empty = tempFile(t, 'empty.gguf', Buffer.alloc(0))
  t.is(await readGgufArchitecture(empty), undefined, 'empty file')

  const missing = path.join(os.tmpdir(), 'missing-model.gguf')
  t.is(await readGgufArchitecture(missing), undefined, 'missing file')
})

test('matchToolDialectFromArchitecture: maps llama.cpp architectures', (t) => {
  const cases: Array<[string | undefined, string | undefined]> = [
    ['qwen35', 'qwen35'],
    ['qwen35moe', 'qwen35'],
    ['qwen4exp', 'qwen35'],
    ['gemma4', 'gemma4'],
    ['gpt-oss', 'harmony'],
    ['deepseek32', 'dsml'],
    ['deepseek4', 'dsml'],
    ['lfm2', 'pythonic'],
    ['lfm2moe', 'pythonic'],
    ['qwen3', undefined],
    ['llama', undefined],
    ['deepseek2', undefined],
    ['constructor', undefined],
    [undefined, undefined]
  ]
  for (const [architecture, dialect] of cases) {
    t.is(matchToolDialectFromArchitecture(architecture), dialect, `architecture=${architecture}`)
  }
})

test('resolveToolDialect: an unmatched name falls back to the GGUF architecture', async (t) => {
  const file = tempFile(t, 'my-finetune-v2.gguf', gguf([arch('qwen35')]))
  t.is(matchToolDialectFromName('MY_FINETUNE', file), undefined, 'the name matches nothing')
  t.is(await resolveToolDialect('MY_FINETUNE', file), 'qwen35')
})

test('resolveToolDialect: a name match wins over the architecture', async (t) => {
  const file = tempFile(t, 'gemma-4-e2b-it.gguf', gguf([arch('qwen35')]))
  t.is(await resolveToolDialect(undefined, file), 'gemma4')
})

test('resolveToolDialect: hermes for unknown architectures and unreadable headers', async (t) => {
  const llama = tempFile(t, 'my-finetune.gguf', gguf([arch('llama')]))
  t.is(await resolveToolDialect(undefined, llama), 'hermes', 'unknown architecture')

  const broken = tempFile(t, 'my-finetune.gguf', Buffer.from('garbage'))
  t.is(await resolveToolDialect(undefined, broken), 'hermes', 'unreadable header')
})

function completionPlugin(modelType: string) {
  return {
    modelType,
    displayName: modelType,
    addonPackage: '@qvac/test',
    loadConfigSchema: z.object({}),
    createModel() {
      return { model: { load: () => Promise.resolve(), unload() {} } }
    },
    handlers: {
      completionStream: {
        requestSchema: z.object({}),
        responseSchema: z.object({}),
        streaming: true,
        handler: async function* () {}
      }
    }
  }
}

async function loadWith(
  t: { teardown(fn: () => void): void },
  modelPath: string,
  modelName?: string
) {
  const modelType = `dialect-test-${Math.random().toString(36).slice(2)}`
  const modelId = `${modelType}-model`
  registerPlugin(completionPlugin(modelType) as never)
  t.teardown(() => {
    unregisterModel(modelId)
    unregisterPlugin(modelType)
  })
  await loadModel({
    modelId,
    modelPath,
    ...(modelName && { modelName }),
    options: {
      type: 'loadModel',
      modelSrc: modelPath,
      modelType,
      modelConfig: {},
      modelFitPolicy: 'off'
    }
  } as never)
  return modelId
}

test('loadModel: stores the detected dialect, and loaded model info reports it', async (t) => {
  const file = tempFile(t, 'custom-finetune.gguf', gguf([arch('qwen35')]))
  const modelId = await loadWith(t, file, 'CUSTOM_FINETUNE')

  t.is(detectToolDialect(modelId), 'qwen35', 'completions parse with the architecture dialect')
  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })
  t.is(info.toolDialect, 'qwen35', 'loaded model info matches')
})

test('loadModel: an unreadable header still loads, with hermes', async (t) => {
  const file = tempFile(t, 'custom-finetune.gguf', Buffer.from('not gguf'))
  const modelId = await loadWith(t, file)

  t.is(detectToolDialect(modelId), 'hermes')
  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })
  t.is(info.toolDialect, 'hermes')
})
