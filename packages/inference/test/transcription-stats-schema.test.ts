import test from 'brittle'
import { transcribeStatsSchema, ASR_BACKEND_IDS } from '@/schemas/transcription'
import { buildAsrBackendDiagnostics } from '@/utils/asr-diagnostics'

test('transcribeStatsSchema: round-trips whisper backend/GPU stats', (t) => {
  const result = transcribeStatsSchema.parse({
    realTimeFactor: 0.25,
    tokensPerSecond: 120,
    backendDevice: 1,
    backendId: 3,
    gpuMemTotalMb: 8192,
    gpuMemFreeMb: 4096
  })
  t.is(result.backendDevice, 1)
  t.is(result.backendId, 3)
  t.is(result.gpuMemTotalMb, 8192)
  t.is(result.gpuMemFreeMb, 4096)
})

test('transcribeStatsSchema: backend/GPU fields are optional (CPU / parakeet path)', (t) => {
  const result = transcribeStatsSchema.parse({ realTimeFactor: 1.5 })
  t.absent(result.backendDevice)
  t.absent(result.backendId)
  t.absent(result.gpuUnsupported)
  t.absent(result.gpuMemTotalMb)
  t.absent(result.gpuMemFreeMb)
})

test('transcribeStatsSchema: round-trips parakeet gpuUnsupported stat', (t) => {
  const result = transcribeStatsSchema.parse({
    backendDevice: 0,
    backendId: 0,
    gpuUnsupported: 1
  })
  t.is(result.backendDevice, 0)
  t.is(result.backendId, 0)
  t.is(result.gpuUnsupported, 1)
})

test('transcribeStatsSchema: accepts the -1 no-accounting sentinel for gpu memory', (t) => {
  const result = transcribeStatsSchema.parse({
    backendDevice: 1,
    backendId: 2,
    gpuMemTotalMb: -1,
    gpuMemFreeMb: -1
  })
  t.is(result.gpuMemTotalMb, -1)
  t.is(result.gpuMemFreeMb, -1)
})

test('transcribeStatsSchema: rejects non-numeric backend fields', (t) => {
  t.exception(() => transcribeStatsSchema.parse({ backendId: 'vulkan' }))
})

test('transcribeStatsSchema: accepts the full addon stats surface', (t) => {
  // Every field @qvac/asr-ggml reports, shared + whisper-only + parakeet-only.
  const result = transcribeStatsSchema.safeParse({
    audioDuration: 1000,
    realTimeFactor: 0.5,
    tokensPerSecond: 12,
    totalTokens: 24,
    totalSegments: 3,
    whisperEncodeTime: 10,
    whisperDecodeTime: 20,
    encoderTime: 5,
    decoderTime: 6,
    melSpecTime: 2,
    backendDevice: 1,
    backendId: 3,
    gpuUnsupported: 0,
    gpuMemTotalMb: 8192,
    gpuMemFreeMb: 4096,
    totalTime: 900,
    totalWallMs: 950,
    totalSamples: 16000,
    processCalls: 4,
    whisperSampleMs: 3,
    whisperBatchdMs: 7,
    whisperPromptMs: 1,
    totalTranscriptions: 2,
    modelLoadMs: 250,
    totalEncodedFrames: 120,
    encoderOnCoreml: 1
  })
  t.ok(result.success, 'every reported stats field is accepted')
})

test('transcribeStatsSchema: the newly surfaced fields survive a parse', (t) => {
  const parsed = transcribeStatsSchema.parse({
    totalTime: 900,
    totalWallMs: 950,
    totalSamples: 16000,
    processCalls: 4,
    whisperSampleMs: 3,
    whisperBatchdMs: 7,
    whisperPromptMs: 1,
    totalTranscriptions: 2,
    modelLoadMs: 250,
    totalEncodedFrames: 120,
    encoderOnCoreml: 1
  })
  t.is(parsed.totalWallMs, 950, 'totalWallMs round-trips')
  t.is(parsed.modelLoadMs, 250, 'modelLoadMs round-trips')
  t.is(parsed.encoderOnCoreml, 1, 'encoderOnCoreml round-trips')
  t.is(parsed.totalEncodedFrames, 120, 'totalEncodedFrames round-trips')
})

test('buildAsrBackendDiagnostics: maps the addon backend verdict', (t) => {
  t.alike(
    buildAsrBackendDiagnostics({ backendDevice: 1, backendId: 1 }),
    { selectedBackend: 'metal', selectedDevice: 'gpu', graphicsApi: 'metal' },
    'GPU run names the backend and the graphics API'
  )
  t.alike(
    buildAsrBackendDiagnostics({ backendDevice: 0, backendId: 0 }),
    { selectedBackend: 'cpu', selectedDevice: 'cpu' },
    'CPU run reports cpu'
  )
  t.is(
    buildAsrBackendDiagnostics({ backendDevice: 1, backendId: 99 }),
    undefined,
    'an unnamed backend against a GPU verdict is not guessed at'
  )
  t.is(
    buildAsrBackendDiagnostics({ backendDevice: 1, backendId: 0 }),
    undefined,
    "a 'cpu' name against backendDevice 1 is the addon contradicting itself"
  )
  t.is(buildAsrBackendDiagnostics({}), undefined, 'no backendDevice means no verdict')
  t.is(buildAsrBackendDiagnostics(undefined), undefined, 'absent stats are tolerated')
})

test('buildAsrBackendDiagnostics: every GPU backend id resolves', (t) => {
  for (const [name, id] of Object.entries(ASR_BACKEND_IDS)) {
    if (name === 'CPU' || name === 'Other') continue
    const d = buildAsrBackendDiagnostics({ backendDevice: 1, backendId: id })
    t.is(d?.selectedBackend, name.toLowerCase(), `${name} maps to its lowercase name`)
    t.is(d?.graphicsApi, name.toLowerCase(), `${name} is a known graphics API`)
  }
})
