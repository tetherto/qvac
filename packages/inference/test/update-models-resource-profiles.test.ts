import test from 'brittle'
import { extractGgufFacts, parseGgufMetadata } from '@/models/update-models/gguf-facts'
import { processRegistryModel } from '@/models/update-models/processing'
import { buildResourceProfile, buildResourceProfiles } from '@/models/update-models/profiles'
import { generateResourceProfilesFileContent } from '@/models/update-models/codegen'
import type { ProcessedModel } from '@/models/update-models/types'

// ---------------------------------------------------------------------------
// Fixtures
//
// Every metadata fixture below is a verbatim subset of what
// `registry-server/lib/gguf-helpers.js` extracts from a real catalog GGUF
// (tokenizer keys stripped, BigInts stringified) — so the key names, value
// types and per-layer arrays match what the registry actually stores.
// ---------------------------------------------------------------------------

// Qwen3.5-4B-Q4_K_M: hybrid attention/recurrent, scalar GQA.
const QWEN35_METADATA = {
  version: 3,
  tensor_count: '426',
  kv_count: '46',
  'general.architecture': 'qwen35',
  'general.name': 'Qwen3.5-4B',
  'qwen35.block_count': 32,
  'qwen35.context_length': 262144,
  'qwen35.embedding_length': 2560,
  'qwen35.attention.head_count': 16,
  'qwen35.attention.head_count_kv': 4,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.ssm.conv_kernel': 4,
  'qwen35.ssm.state_size': 128,
  'qwen35.ssm.group_count': 16,
  'qwen35.ssm.inner_size': 4096,
  'qwen35.full_attention_interval': 4
}

// gte-large fp16: bert embedding model with no GQA and no explicit head dims.
const BERT_METADATA = {
  version: 3,
  'general.architecture': 'bert',
  'general.name': 'gte-large',
  'bert.block_count': 24,
  'bert.context_length': 512,
  'bert.embedding_length': 1024,
  'bert.attention.head_count': 16,
  'bert.pooling_type': 1
}

// gpt-oss-20b-Q4_K_M: sliding window, but no per-layer pattern in the file.
const GPT_OSS_METADATA = {
  'general.architecture': 'gpt-oss',
  'gpt-oss.block_count': 24,
  'gpt-oss.context_length': 131072,
  'gpt-oss.embedding_length': 2880,
  'gpt-oss.attention.head_count': 64,
  'gpt-oss.attention.head_count_kv': 8,
  'gpt-oss.attention.key_length': 64,
  'gpt-oss.attention.value_length': 64,
  'gpt-oss.attention.sliding_window': 128
}

// gemma-4-31B-it-Q4_K_M: attention described per layer. 5 sliding-window
// blocks (16 KV heads, 256-wide) for every full-attention block (4 KV heads,
// 512-wide), 60 blocks in total.
function gemma4Metadata() {
  const headCountKv: number[] = []
  const swaPattern: boolean[] = []
  for (let layer = 0; layer < 60; layer++) {
    const windowed = (layer + 1) % 6 !== 0
    headCountKv.push(windowed ? 16 : 4)
    swaPattern.push(windowed)
  }

  return {
    'general.architecture': 'gemma4',
    'gemma4.block_count': 60,
    'gemma4.context_length': 262144,
    'gemma4.embedding_length': 5376,
    'gemma4.attention.head_count': 32,
    'gemma4.attention.head_count_kv': headCountKv,
    'gemma4.attention.key_length': 512,
    'gemma4.attention.value_length': 512,
    'gemma4.attention.sliding_window': 1024,
    'gemma4.attention.key_length_swa': 256,
    'gemma4.attention.value_length_swa': 256,
    'gemma4.attention.sliding_window_pattern': swaPattern
  }
}

function processedModel(overrides: Partial<ProcessedModel> = {}): ProcessedModel {
  return {
    registryPath: 'org/repo/model-Q4_K_M.gguf',
    registrySource: 'hf',
    blobCoreKey: 'aa'.repeat(32),
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    modelId: 'model-Q4_K_M.gguf',
    addon: 'llm',
    expectedSize: 1_000,
    sha256Checksum: 'a'.repeat(64),
    engine: 'llamacpp-completion',
    modelName: 'repo',
    quantization: 'Q4_K_M',
    params: '4B',
    tags: [],
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// parseGgufMetadata
// ---------------------------------------------------------------------------

test('parseGgufMetadata: returns null for an absent field', (t) => {
  t.is(parseGgufMetadata(undefined), null)
  t.is(parseGgufMetadata(''), null)
})

test('parseGgufMetadata: returns null for unparseable or non-object JSON', (t) => {
  t.is(parseGgufMetadata('{ not json'), null)
  t.is(parseGgufMetadata('[1, 2, 3]'), null)
  t.is(parseGgufMetadata('"a string"'), null)
  t.is(parseGgufMetadata('null'), null)
})

test('parseGgufMetadata: parses a stored metadata string', (t) => {
  const parsed = parseGgufMetadata(JSON.stringify(QWEN35_METADATA))
  t.ok(parsed)
  t.is(parsed!['general.architecture'], 'qwen35')
})

// ---------------------------------------------------------------------------
// extractGgufFacts
// ---------------------------------------------------------------------------

test('extractGgufFacts: reads a hybrid GQA model with explicit head dims', (t) => {
  const facts = extractGgufFacts(QWEN35_METADATA)
  t.ok(facts)
  t.is(facts!.architecture, 'qwen35')
  t.is(facts!.blockCount, 32)
  t.is(facts!.headCount, 16)
  t.is(facts!.headCountKv, 4)
  t.is(facts!.keyLength, 256)
  t.is(facts!.valueLength, 256)
  t.is(facts!.embeddingLength, 2560)
  t.is(facts!.contextLength, 262144)
  t.is(facts!.fullAttentionInterval, 4)
  t.is(facts!.ssmStateSize, 128)
  t.is(facts!.ssmConvKernel, 4)
  t.is(facts!.ssmInnerSize, 4096)
  t.is(facts!.ssmGroupCount, 16)
  t.absent(facts!.kvLayerClasses)
  t.absent(facts!.assumptions)
})

test('extractGgufFacts: falls back to head_count and per-head width for bert', (t) => {
  const facts = extractGgufFacts(BERT_METADATA)
  t.ok(facts)
  t.is(facts!.headCountKv, 16, 'no GQA — one KV head per attention head')
  t.is(facts!.keyLength, 64, '1024 / 16')
  t.is(facts!.valueLength, 64)
  t.alike(facts!.assumptions, [
    'head_count_kv absent — assumed equal to head_count (no GQA)',
    'key_length/value_length absent — derived from embedding_length / head_count'
  ])
})

test('extractGgufFacts: keeps the sliding window when the file has no layer pattern', (t) => {
  const facts = extractGgufFacts(GPT_OSS_METADATA)
  t.ok(facts)
  t.is(facts!.slidingWindow, 128)
  t.absent(facts!.keyLengthSwa)
  t.absent(facts!.kvLayerClasses, 'no per-layer arrays — flat fields describe every block')
})

test('extractGgufFacts: collapses per-layer attention into layer classes', (t) => {
  const facts = extractGgufFacts(gemma4Metadata())
  t.ok(facts)
  t.is(facts!.headCountKv, 16, 'flat field takes the maximum of the per-layer array')
  t.is(facts!.slidingWindow, 1024)
  t.is(facts!.keyLengthSwa, 256)
  t.is(facts!.valueLengthSwa, 256)
  t.alike(facts!.kvLayerClasses, [
    { count: 50, headCountKv: 16, keyLength: 256, valueLength: 256, windowed: true },
    { count: 10, headCountKv: 4, keyLength: 512, valueLength: 512, windowed: false }
  ])
  t.is(
    facts!.kvLayerClasses!.reduce((sum, layerClass) => sum + layerClass.count, 0),
    60,
    'classes account for every block'
  )
  t.ok(facts!.assumptions!.includes('head_count_kv is per-layer — used the maximum'))
  t.ok(facts!.assumptions!.includes('kvLayerClasses derived from per-layer attention metadata'))
})

test('extractGgufFacts: parses stringified BigInt values', (t) => {
  const facts = extractGgufFacts({
    'general.architecture': 'llama',
    'llama.block_count': '32',
    'llama.context_length': '131072',
    'llama.embedding_length': '4096',
    'llama.attention.head_count': '32',
    'llama.attention.head_count_kv': '8',
    'general.parameter_count': '8030261248'
  })
  t.ok(facts)
  t.is(facts!.blockCount, 32)
  t.is(facts!.contextLength, 131072)
  t.is(facts!.headCountKv, 8)
  t.is(facts!.parameterCount, 8030261248)
  t.is(facts!.keyLength, 128, '4096 / 32')
})

test('extractGgufFacts: returns null without an architecture', (t) => {
  t.is(extractGgufFacts({ 'llama.block_count': 32 }), null)
  t.is(extractGgufFacts(null), null)
})

test('extractGgufFacts: returns null when a required dimension is missing', (t) => {
  // Diffusion and other non-transformer GGUFs carry an architecture but none of
  // the attention keys — they must produce no facts rather than partial ones.
  t.is(
    extractGgufFacts({
      'general.architecture': 'sd',
      'general.name': 'stable-diffusion-v2-1'
    }),
    null
  )
  t.is(
    extractGgufFacts({
      'general.architecture': 'llama',
      'llama.block_count': 32,
      'llama.embedding_length': 4096,
      'llama.attention.head_count': 32
    }),
    null,
    'no context_length'
  )
})

test('extractGgufFacts: ignores per-layer arrays whose length disagrees with block_count', (t) => {
  const facts = extractGgufFacts({
    'general.architecture': 'gemma4',
    'gemma4.block_count': 60,
    'gemma4.context_length': 8192,
    'gemma4.embedding_length': 5376,
    'gemma4.attention.head_count': 32,
    'gemma4.attention.head_count_kv': [16, 4, 16],
    'gemma4.attention.key_length': 512,
    'gemma4.attention.value_length': 512
  })
  t.ok(facts)
  t.is(facts!.headCountKv, 16, 'flat maximum still usable')
  t.absent(facts!.kvLayerClasses, 'truncated array is not trusted for a per-layer sum')
})

// ---------------------------------------------------------------------------
// processRegistryModel
// ---------------------------------------------------------------------------

test('processRegistryModel: attaches facts from the registry ggufMetadata', (t) => {
  const model = processRegistryModel({
    path: 'unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf',
    source: 'hf',
    engine: '@qvac/llm-llamacpp',
    quantization: 'Q4_K_M',
    params: '4B',
    blobBinding: {
      coreKey: Buffer.from('ab'.repeat(32), 'hex'),
      blockOffset: 0,
      blockLength: 1,
      byteOffset: 0,
      byteLength: 2_500_000_000,
      sha256: 'c'.repeat(64)
    },
    ggufMetadata: JSON.stringify(QWEN35_METADATA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  t.ok(model)
  t.is(model!.ggufFacts?.architecture, 'qwen35')
  t.is(model!.ggufFacts?.blockCount, 32)
})

test('processRegistryModel: leaves facts absent when metadata is missing or broken', (t) => {
  function processWith(ggufMetadata: string | undefined) {
    return processRegistryModel({
      path: 'org/repo/ggml-tiny.bin',
      source: 'hf',
      engine: 'whispercpp-transcription',
      blobBinding: {
        coreKey: Buffer.from('ab'.repeat(32), 'hex'),
        blockOffset: 0,
        blockLength: 1,
        byteOffset: 0,
        byteLength: 77_700_000,
        sha256: 'd'.repeat(64)
      },
      ggufMetadata
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }

  t.absent(processWith(undefined)!.ggufFacts, 'non-GGUF artifact')
  t.absent(processWith('{ truncated')!.ggufFacts, 'unparseable metadata')
})

// ---------------------------------------------------------------------------
// buildResourceProfile
// ---------------------------------------------------------------------------

test('buildResourceProfile: single-file model sizes to its own bytes', (t) => {
  const profile = buildResourceProfile(processedModel({ expectedSize: 2_500_000_000 }))
  t.is(profile.schemaVersion, 1)
  t.is(profile.engine, 'llamacpp-completion')
  t.is(profile.artifactBytes, 2_500_000_000)
  t.absent(profile.ggufFacts)
  t.absent(profile.assumptions)
})

test('buildResourceProfile: sharded model uses the pre-summed total, never double-counts', (t) => {
  // groupShardedModels already sets expectedSize to the sum of every shard and
  // lists all shards (the first included) in shardMetadata.
  const profile = buildResourceProfile(
    processedModel({
      expectedSize: 30,
      shardMetadata: [
        { filename: 'a-00001-of-00002.gguf', expectedSize: 10 } as never,
        { filename: 'a-00002-of-00002.gguf', expectedSize: 20 } as never
      ]
    })
  )
  t.is(profile.artifactBytes, 30)
  t.alike(profile.assumptions, ['artifactBytes sums 2 shards'])
})

test('buildResourceProfile: companion set sums every file exactly once', (t) => {
  // companionSet.files includes the primary, so the primary's expectedSize must
  // not be added on top of the set.
  const profile = buildResourceProfile(
    processedModel({
      expectedSize: 100,
      companionSet: {
        setKey: 'deadbeefdeadbeef',
        primaryKey: 'modelPath',
        files: [
          { key: 'modelPath', expectedSize: 100, primary: true } as never,
          { key: 'dataPath', expectedSize: 400 } as never
        ]
      }
    })
  )
  t.is(profile.artifactBytes, 500)
  t.alike(profile.assumptions, ['artifactBytes sums 2 companion-set files'])
})

test('buildResourceProfile: carries GGUF facts through', (t) => {
  const facts = extractGgufFacts(QWEN35_METADATA)!
  const profile = buildResourceProfile(processedModel({ ggufFacts: facts }))
  t.alike(profile.ggufFacts, facts)
})

// ---------------------------------------------------------------------------
// buildResourceProfiles
// ---------------------------------------------------------------------------

test('buildResourceProfiles: keys by checksum and skips entries without one', (t) => {
  const profiles = buildResourceProfiles([
    processedModel({ sha256Checksum: 'a'.repeat(64), expectedSize: 1 }),
    processedModel({ sha256Checksum: 'b'.repeat(64), expectedSize: 2 }),
    processedModel({ sha256Checksum: '', expectedSize: 3 })
  ])

  t.alike(Object.keys(profiles).sort(), ['a'.repeat(64), 'b'.repeat(64)])
  t.is(profiles['b'.repeat(64)]!.artifactBytes, 2)
})

test('buildResourceProfiles: first entry wins on a checksum collision', (t) => {
  const profiles = buildResourceProfiles([
    processedModel({ sha256Checksum: 'a'.repeat(64), expectedSize: 1 }),
    processedModel({ sha256Checksum: 'a'.repeat(64), expectedSize: 999 })
  ])

  t.is(Object.keys(profiles).length, 1)
  t.is(profiles['a'.repeat(64)]!.artifactBytes, 1)
})

// ---------------------------------------------------------------------------
// generateResourceProfilesFileContent
// ---------------------------------------------------------------------------

test('generateResourceProfilesFileContent: emits a self-contained generated module', (t) => {
  const content = generateResourceProfilesFileContent([
    processedModel({
      sha256Checksum: 'b'.repeat(64),
      expectedSize: 2_500_000_000,
      ggufFacts: extractGgufFacts(QWEN35_METADATA)!
    }),
    processedModel({
      sha256Checksum: 'a'.repeat(64),
      engine: 'whispercpp-transcription',
      addon: 'whisper',
      expectedSize: 77_700_000
    })
  ])

  t.ok(content.startsWith('// THIS FILE IS AUTO-GENERATED BY models/update-models'))
  // Built at runtime: a literal `@/…` here would be rewritten by tsc-alias in
  // this test's own compiled output, the same hazard codegen works around.
  const aliasImport = ['@', '/', 'schemas/model-resource-profile'].join('')
  t.ok(content.includes(`import type { ModelResourceProfile } from "${aliasImport}"`))
  t.ok(content.includes('export const MODEL_RESOURCE_PROFILES'))
  t.ok(content.includes('export function getModelResourceProfile'))

  const firstKey = content.indexOf('"' + 'a'.repeat(64) + '"')
  const secondKey = content.indexOf('"' + 'b'.repeat(64) + '"')
  t.ok(firstKey > 0 && secondKey > firstKey, 'entries are checksum-sorted for a stable diff')
  t.ok(content.includes('"artifactBytes":2500000000'))
  t.ok(content.includes('"architecture":"qwen35"'))
})
