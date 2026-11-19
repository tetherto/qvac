'use strict'

const DEFAULT_DIAR_CHUNK_MS = 2000
const MIN_DIAR_CHUNK_MS = 200

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

function assertCacheAwareAsr(model) {
  if (model.getBackendInfo()?.supportsCacheAwareStreaming !== true) {
    throw new Error(
      'Diarized mic transcription requires a cache-aware ASR checkpoint. Use Parakeet Unified RNN-T or Nemotron with --asr-model.'
    )
  }
}

async function finishDiarizedMic(sessions, runs) {
  for (const { stream } of sessions) stream.end()
  await Promise.allSettled(runs)
  await Promise.allSettled(sessions.map(({ model }) => model.unload()))
}

async function startDiarizedMic(asr, diar, startCapture) {
  const sessions = [asr, diar]
  const runs = []
  try {
    await asr.model.load()
    assertCacheAwareAsr(asr.model)
    await diar.model.load()

    for (const { model, stream, options, onUpdate } of sessions) {
      const response = await model.runStreaming(stream, options)
      const completion = response.onUpdate(onUpdate).await()
      // The other session or capture can fail before the caller receives these promises.
      completion.catch(() => {})
      runs.push(completion)
    }

    return { child: startCapture(), runs }
  } catch (error) {
    await finishDiarizedMic(sessions, runs)
    throw error
  }
}

function spawnMicCapture(subprocess, command) {
  const [binary, ...args] = command.split(' ')
  try {
    return subprocess.spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `'${binary}' not found on PATH. Install SoX (brew install sox / apt install sox / choco install sox / winget install ChrisBagwell.SoX).`
      )
    }
    throw error
  }
}

module.exports = {
  parseMicChunkMs,
  buildMicChunkOptions,
  startDiarizedMic,
  finishDiarizedMic,
  spawnMicCapture
}
