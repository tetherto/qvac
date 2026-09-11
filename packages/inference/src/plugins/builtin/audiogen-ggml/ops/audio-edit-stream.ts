import { RepaintMode, type AudioEditSession } from '@qvac/audiogen-ggml'
import {
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  type AudioEditOperation,
  type AudioEditStreamRequest,
  type AudioEditStreamResponse,
  type AudioGenRepaintMode
} from '@/schemas/audio-gen'
import {
  assertNormalizedPcm,
  resolveAudioGenPcm
} from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-input'
import { streamAudioGenRun } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-run'

// The wire vocabulary is the addon's own enum values; the map keeps the
// string-enum typing honest instead of casting across the boundary.
const REPAINT_MODES: Record<AudioGenRepaintMode, RepaintMode> = {
  conservative: RepaintMode.Conservative,
  balanced: RepaintMode.Balanced,
  aggressive: RepaintMode.Aggressive
}

export function audioEditStream(
  request: AudioEditStreamRequest
): AsyncGenerator<AudioEditStreamResponse> {
  return streamAudioGenRun({
    type: 'audioEditStream',
    request,
    async start(model, ctx) {
      // The source is decoded before the run is admitted so the model slot is
      // never held by a request that fails on input decoding. The addon also
      // requires edit sources in [-1, 1], which the decoder path guarantees
      // but raw PCM input does not.
      const pcm = await resolveAudioGenPcm(request.sourceAudio, 'sourceAudio')
      assertNormalizedPcm(pcm, 'sourceAudio')
      if (ctx.signal.aborted) return undefined

      // The addon validates each operation as it is chained (Flow-Edit on a
      // turbo DiT, repaint ranges inside the source, ...); those throws
      // surface as the request's error before any native work starts.
      const session = model.edit({
        pcm,
        sampleRate: AUDIOGEN_INPUT_SAMPLE_RATE,
        channels: AUDIOGEN_INPUT_CHANNELS
      })
      for (const operation of request.operations) appendOperation(session, operation)
      return session.run({ ...(request.seed !== undefined && { seed: request.seed }) })
    }
  })
}

function appendOperation(session: AudioEditSession, operation: AudioEditOperation): void {
  if (operation.type === 'flow-edit') {
    session.flowEdit({
      from: {
        caption: operation.from.caption,
        ...(operation.from.lyrics !== undefined && { lyrics: operation.from.lyrics })
      },
      to: {
        caption: operation.to.caption,
        ...(operation.to.lyrics !== undefined && { lyrics: operation.to.lyrics })
      },
      ...(operation.nMin !== undefined && { nMin: operation.nMin }),
      ...(operation.nMax !== undefined && { nMax: operation.nMax }),
      ...(operation.nAvg !== undefined && { nAvg: operation.nAvg })
    })
    return
  }
  session.repaint({
    caption: operation.caption,
    ...(operation.lyrics !== undefined && { lyrics: operation.lyrics }),
    start: operation.start,
    ...(operation.end !== undefined && { end: operation.end }),
    ...(operation.mode !== undefined && { mode: REPAINT_MODES[operation.mode] }),
    ...(operation.strength !== undefined && { strength: operation.strength })
  })
}
