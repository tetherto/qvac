import type ASRGgml from '@qvac/asr-ggml'
import type { EndOfTurnEvent, VadStateEvent } from '@/schemas'

export function isVadEvent(event: ASRGgml.ASRStreamOutput): event is ASRGgml.VadEvent {
  return (
    !Array.isArray(event) &&
    event.type === 'vad' &&
    typeof event.speaking === 'boolean' &&
    typeof event.score === 'number' &&
    (event.source === 'silero' || event.source === 'energy')
  )
}

export function isEndOfTurnEvent(event: ASRGgml.ASRStreamOutput): event is ASRGgml.EndOfTurnEvent {
  return (
    !Array.isArray(event) &&
    event.type === 'endOfTurn' &&
    (event.source === 'vad-silence' || event.source === 'model-eou')
  )
}

export function toVadStateEvent(event: ASRGgml.VadEvent) {
  return {
    speaking: event.speaking,
    probability: event.score
  } satisfies VadStateEvent
}

export function toEndOfTurnEvent(event: ASRGgml.EndOfTurnEvent) {
  if (event.source === 'model-eou') {
    return { source: 'parakeet' } satisfies EndOfTurnEvent
  }
  if (event.silenceDurationMs === undefined) {
    return null
  }
  return {
    source: 'whisper',
    silenceDurationMs: event.silenceDurationMs
  } satisfies EndOfTurnEvent
}
