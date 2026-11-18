'use strict'

const DEFAULT_DIAR_CHUNK_MS = 2000
const MIN_DIAR_CHUNK_MS = 200
const CACHE_AWARE_ASR_TYPES = new Set(['rnnt', 'nemotron'])

function parseMicChunkMs(flag, value) {
  const ms = Number(value)
  const minimum = flag === '--asr-chunk-ms' ? 1 : MIN_DIAR_CHUNK_MS
  if (!Number.isSafeInteger(ms) || ms < minimum) {
    throw new Error(`${flag} requires an integer of at least ${minimum} ms`)
  }
  return ms
}

function buildMicChunkOptions({ asrChunkMs, diarChunkMs }) {
  return {
    asrOptions: asrChunkMs === undefined ? {} : { chunkMs: asrChunkMs },
    diarStreamingChunkMs: diarChunkMs ?? DEFAULT_DIAR_CHUNK_MS
  }
}

async function loadDiarizedMicAsr(model) {
  await model.load()
  const modelType = model.getBackendInfo()?.modelType
  if (CACHE_AWARE_ASR_TYPES.has(modelType)) return

  await model.unload()
  throw new Error(
    'Diarized mic transcription requires a cache-aware ASR checkpoint. Use Parakeet Unified RNN-T or Nemotron with --asr-model.'
  )
}

module.exports = { parseMicChunkMs, buildMicChunkOptions, loadDiarizedMicAsr }
