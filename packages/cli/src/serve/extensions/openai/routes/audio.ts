import { randomBytes } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { transcribe, textToSpeech, textToSpeechStream } from '@qvac/sdk'
import type { TextToSpeechStreamResponse, TranscribeSegment } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { initSSE, sendSSE, endSSE } from '@/serve/lib/sse'
import { multipartToBody } from '@/serve/lib/multipart'
import {
  formatTimedTranscription,
  isTimedTranscriptionFormat
} from '@/serve/lib/transcription-response'
import { resolveAndCheckModel, ensureReady } from '@/serve/core/plugins/require-model'
import { logUnsupported } from '@/serve/core/plugins/log-unsupported'
import {
  transcriptionsBody,
  assertTranscriptionOptionsSupported,
  translationsBody,
  audioSpeechBody,
  voicesListResponse,
  SPEECH_UNSUPPORTED_PARAMS,
  type SpeechVoice,
  type VoiceObject
} from '@/serve/extensions/openai/schemas/audio'
import { resolveModelAlias } from '@/serve/core/config/models'
import { openaiOptions } from '@/serve/extensions/openai/config'
import {
  buildStreamingWavHeader,
  buildWavBuffer,
  int16SamplesToBuffer,
  mapResponseFormat,
  pcmContentType,
  resolveSampleRate,
  speechAliasKey
} from '@/serve/extensions/openai/audio'
import {
  transcodeWav,
  AudioEncodeFailedError,
  AudioEncodeTimeoutError
} from '@/serve/lib/audio-transcode'
import type { ModelEntry } from '@/serve/core/model-registry'
import type { ResolvedModelEntry } from '@/serve/core/config/types'
import { openaiState, type OpenAIState } from '@/serve/extensions/openai/state'

type SpeechMatchMode = 'voice_map' | 'hyphen' | 'model'

// The SDK's textToSpeechStream session rejects these engines.
const BATCH_ONLY_TTS_ENGINES = new Set(['moss-sfx', 'moss-speech'])

const SUPPORTED_TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'srt', 'vtt', 'verbose_json'])

const descriptions = {
  transcribe: `
Speech-to-text via Whisper-cpp / Parakeet / MOSS. Multipart body with required
\`file\` (audio bytes) and \`model\` (alias of a registered transcription
model).

**\`response_format\`** accepts \`json\` (default), \`text\`, \`srt\`, \`vtt\`,
and \`verbose_json\`. \`json\` and \`text\` work with Whisper, Parakeet,
and MOSS transcription aliases. SRT/VTT require Whisper or MOSS segment metadata.
Parakeet also supports \`verbose_json\`, including offline diarization turns.
\`verbose_json\` exposes text, duration, segment id/start/end/text, and available speaker/speaker_id labels.
Its duration is the latest segment or speaker-turn end, not the submitted
audio length.
Unknown values return \`400 invalid_response_format\`.

**MOSS options:** \`hotwords\` is a JSON array of up to 64 nonempty terms, each
limited to 64 UTF-8 bytes. Use it instead of \`prompt\`. \`max_new_tokens\` sets
the decoding limit (0 uses the model default).

**\`language\`** is honored as a model-load-time config, not per request.
Sending it logs a warning and uses whatever language the model was loaded
with.

**\`temperature\`** is logged as ignored.

**Validation order**: \`Content-Type\` must be multipart → schema (file + model
required) → known-format check → model resolution → engine capability check →
SDK call.
`.trim(),
  translate: `
Speech-to-English-text via a Whisper translation model. Multipart body, same
required fields as transcriptions.

**Output is always English** — the underlying capability is fixed. Sending a
\`language\` field returns \`400 unsupported_param\`.

Translation supports the same \`json\`, \`text\`, \`srt\`, \`vtt\`, and partial
\`verbose_json\` response formats. Timed formats use Whisper segment metadata.
Partial \`verbose_json\` duration is the end of the last transcribed segment,
not the submitted audio length.

The model must be registered with sdkType
\`whispercpp-audio-translation\` (i.e. \`endpointCategory: 'audio-translation'\`)
— a plain transcription model is rejected with \`invalid_model_type\`.
`.trim(),
  speech: `
Synthesize speech from \`input\` text. **The response is raw audio bytes**
(not JSON) with the appropriate \`Content-Type\` (\`audio/wav\`,
\`audio/L16; rate=<sr>; channels=1\`, \`audio/mpeg\`, etc.). The
\`X-Audio-Sample-Rate\` / \`X-Audio-Channels\` / \`X-Audio-Bits-Per-Sample\`
headers are sent for the native \`wav\`/\`pcm\` bodies only.

**Model lookup is voice-aware** (multi-stage): the server first checks the
\`serve.openai.audio.speech.voices\` map (\`voice → alias\`), then a hyphen
alias (\`{model}-{voice}\`), then the bare \`model\`. If no candidate
resolves, the error message lists all three lookup keys it tried.

**\`voice\`** is required unless \`serve.openai.audio.speech.defaultVoice\` is
configured (default: \`"alloy"\`). It takes a built-in OpenAI voice name, any
other string, or a custom voice reference \`{ "id": "..." }\`, which routes the
same way as its \`id\` string.

**\`input_too_long\`** is returned when \`input.length\` exceeds
\`serve.openai.audio.speech.maxInputChars\` (default 4096). Whitespace-only
input is rejected as \`missing_input\`.

**\`response_format\`** accepts \`wav\` (default) and \`pcm\` natively, plus
\`mp3\`, \`opus\`, \`aac\`, \`flac\` when \`ffmpeg\` is on the server's PATH.
Those four return \`503 transcode_unavailable\` when ffmpeg is absent; unknown
values return \`400 invalid_response_format\`.

**\`stream_format\`** accepts \`audio\` (default, the audio body above) and
\`sse\`. With \`sse\` the response is \`text/event-stream\`: one
\`speech.audio.delta\` event per synthesized chunk (\`audio\` is base64), then
\`speech.audio.done\`. \`usage\` token counts are always 0. \`sse\` supports
\`wav\` (a streaming header with unknown length) and \`pcm\` only; other
formats return \`400 unsupported_response_format\`. Unknown values return
\`400 invalid_stream_format\`. MOSS-SoundEffect and MOSS-Speech aliases
(\`ttsEngine\` \`moss-sfx\` / \`moss-speech\`) are batch-only and return
\`400 unsupported_stream_format\` with \`sse\`. Errors before the first audio chunk return JSON
as usual; a failure after it arrives as a final \`{ "error": ... }\` event.

**Error codes:** \`400\` \`missing_input\`, \`input_too_long\`,
\`missing_voice\`, \`invalid_response_format\`, \`invalid_stream_format\`,
\`unsupported_response_format\`, \`unsupported_stream_format\`,
\`invalid_model_type\`; \`404\`
\`model_not_found\`; \`502\` \`speech_empty\`, \`transcode_failed\`; \`503\`
\`transcode_unavailable\`, \`model_not_ready\`.

**Ignored params** (logged, returned in \`X-QVAC-Ignored-Params\` header):
\`speed\`, \`instructions\`.
`.trim(),
  voices: `
List the configured TTS voices. Returns the OpenAI \`voice\` names mapped under
\`serve.openai.audio.speech.voices\` plus the configured \`defaultVoice\`.

The response carries both a flat \`voices\` array (consumed by clients such as
Open WebUI's voice selector) and an OpenAI-style \`data\` array. QVAC enforces no
fixed voice catalog, so callers may also send any \`voice\` string that resolves
via a \`{model}-{voice}\` alias.
`.trim(),
  models: `
List loaded (READY) text-to-speech models — the speech-capable subset of
\`/v1/models\`. Same \`{ object: "list", data: [...] }\` shape, filtered to
models whose endpoint category is \`speech\`.
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const openai = openaiState(app.qvac)

  app.post(
    '/v1/audio/transcriptions',
    {
      schema: {
        body: transcriptionsBody,
        tags: ['Audio'],
        summary: 'Audio transcription',
        description: descriptions.transcribe,
        consumes: ['multipart/form-data']
      },
      preValidation: multipartToBody
    },
    async (req, reply) => {
      const body = req.body
      const file = body.file as Buffer
      const fileMeta = req.multipartFiles?.find((f) => f.fieldname === 'file')
      const responseFormat = (body.response_format as string | undefined) ?? 'json'

      assertKnownTranscriptionFormat(responseFormat)
      if (body.language !== undefined) {
        app.qvac.logger.warn(
          `language="${String(body.language)}" is configured at model load time. Per-request language override is not yet supported.`
        )
      }
      if (body.temperature !== undefined) {
        app.qvac.logger.warn(`Ignoring unsupported param: temperature=${String(body.temperature)}`)
      }

      const { sdkModelId, alias, entry } = await resolveAndCheckModel(
        req,
        reply,
        String(body.model),
        'transcription'
      )
      assertTimedFormatSupported(responseFormat, entry.sdkType)
      assertTranscriptionOptionsSupported(body, entry.sdkType)
      const fileSizeKB = Math.round(file.length / 1024)
      app.qvac.logger.info(
        `  transcribe model=${alias} file=${fileMeta?.filename ?? ''} size=${fileSizeKB}KB ` +
          `format=${responseFormat}${body.prompt ? ' prompt=yes' : ''}`
      )

      const tmpPath = await writeTempAudio(file, fileMeta)
      let text: string
      let segments: TranscribeSegment[] | undefined
      try {
        const result = await invokeTranscription(
          req,
          openai.transcribeOverride,
          {
            modelId: sdkModelId,
            audioChunk: tmpPath,
            ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {}),
            ...(body.hotwords !== undefined ? { hotwords: body.hotwords } : {}),
            ...(body.max_new_tokens !== undefined ? { maxNewTokens: body.max_new_tokens } : {})
          },
          isTimedTranscriptionFormat(responseFormat),
          'transcription'
        )
        text = result.text
        segments = result.segments
      } finally {
        await unlink(tmpPath).catch(() => undefined)
      }
      app.qvac.logger.info(`  transcribe done chars=${text.length}`)

      if (segments !== undefined && isTimedTranscriptionFormat(responseFormat)) {
        const formatted = formatTimedTranscription(responseFormat, segments)
        reply.type(formatted.contentType).send(formatted.body)
        return
      }
      if (responseFormat === 'text') {
        reply.type('text/plain').send(text)
        return
      }
      return { text }
    }
  )

  app.post(
    '/v1/audio/translations',
    {
      schema: {
        body: translationsBody,
        tags: ['Audio'],
        summary: 'Audio translation (to English)',
        description: descriptions.translate,
        consumes: ['multipart/form-data']
      },
      preValidation: multipartToBody
    },
    async (req, reply) => {
      const body = req.body
      const file = body.file as Buffer
      const fileMeta = req.multipartFiles?.find((f) => f.fieldname === 'file')
      const responseFormat = (body.response_format as string | undefined) ?? 'json'

      if (body.language !== undefined) {
        throw new HttpError(
          400,
          'unsupported_param',
          'The "language" field is not supported on /v1/audio/translations. Output is always English.'
        )
      }
      assertKnownTranscriptionFormat(responseFormat)
      if (body.temperature !== undefined) {
        app.qvac.logger.warn(`Ignoring unsupported param: temperature=${String(body.temperature)}`)
      }

      const { sdkModelId, alias, entry } = await resolveAndCheckModel(
        req,
        reply,
        String(body.model),
        'audio-translation'
      )
      assertTimedFormatSupported(responseFormat, entry.sdkType)
      const fileSizeKB = Math.round(file.length / 1024)
      app.qvac.logger.info(
        `  translate model=${alias} file=${fileMeta?.filename ?? ''} size=${fileSizeKB}KB ` +
          `format=${responseFormat}${body.prompt ? ' prompt=yes' : ''}`
      )

      const tmpPath = await writeTempAudio(file, fileMeta)
      let text: string
      let segments: TranscribeSegment[] | undefined
      try {
        const result = await invokeTranscription(
          req,
          openai.transcribeOverride,
          {
            modelId: sdkModelId,
            audioChunk: tmpPath,
            ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {})
          },
          isTimedTranscriptionFormat(responseFormat),
          'translation'
        )
        text = result.text
        segments = result.segments
      } finally {
        await unlink(tmpPath).catch(() => undefined)
      }
      app.qvac.logger.info(`  translate done chars=${text.length}`)

      if (segments !== undefined && isTimedTranscriptionFormat(responseFormat)) {
        const formatted = formatTimedTranscription(responseFormat, segments)
        reply.type(formatted.contentType).send(formatted.body)
        return
      }
      if (responseFormat === 'text') {
        reply.type('text/plain').send(text)
        return
      }
      return { text }
    }
  )

  app.post(
    '/v1/audio/speech',
    {
      schema: {
        body: audioSpeechBody,
        tags: ['Audio'],
        summary: 'Text-to-speech',
        description: descriptions.speech
      },
      config: { unsupportedParams: [...SPEECH_UNSUPPORTED_PARAMS], sseSentinel: false },
      preHandler: logUnsupported
    },
    async (req, reply) => {
      const body = req.body
      const modelName = body.model.trim()
      const input = body.input
      const ctx = app.qvac

      // Zod min(1) lets whitespace-only through; legacy treats it as empty.
      if (!input.trim()) {
        throw new HttpError(
          400,
          'missing_input',
          '"input" is required and must be a non-empty string.'
        )
      }

      const speechOptions = openaiOptions(ctx.serveConfig).audio.speech
      const maxInputChars = speechOptions.maxInputChars
      if (maxInputChars !== null && input.length > maxInputChars) {
        throw new HttpError(
          400,
          'input_too_long',
          `"input" exceeds the configured limit of ${maxInputChars} characters (got ${input.length}). ` +
            'Raise serve.openai.audio.speech.maxInputChars or split the request.'
        )
      }

      const voice = resolveVoice(body.voice, speechOptions.defaultVoice)
      if (voice === null) {
        throw new HttpError(
          400,
          'missing_voice',
          '"voice" is required (no default voice configured).'
        )
      }

      const formatMapping = mapResponseFormat(body.response_format)
      if (formatMapping.kind === 'invalid') {
        throw new HttpError(400, 'invalid_response_format', formatMapping.message)
      }
      const streamFormat = body.stream_format ?? 'audio'
      if (streamFormat !== 'audio' && streamFormat !== 'sse') {
        throw new HttpError(
          400,
          'invalid_stream_format',
          `Unknown stream_format "${streamFormat}". Use "audio" or "sse".`
        )
      }
      if (streamFormat === 'sse' && formatMapping.kind === 'transcoded') {
        throw new HttpError(
          400,
          'unsupported_response_format',
          `stream_format "sse" supports response_format "wav" or "pcm", not "${formatMapping.format}".`
        )
      }
      if (formatMapping.kind === 'transcoded' && !openai.ffmpegAvailable) {
        throw new HttpError(
          503,
          'transcode_unavailable',
          `response_format "${formatMapping.format}" requires ffmpeg on the server's PATH (not found). Use "wav" or "pcm", or install ffmpeg. See: qvac doctor`
        )
      }

      // voice_map → hyphen alias → bare model (multi-stage lookup).
      const aliasKey = speechAliasKey(modelName, voice)
      const voiceKey = voice.toLowerCase()
      const voiceMapAlias = speechOptions.voices?.[voiceKey] ?? null

      let modelEntry: ResolvedModelEntry | ModelEntry | null = null
      let resolvedAlias = ''
      let matchMode: SpeechMatchMode = 'model'

      if (typeof voiceMapAlias === 'string' && voiceMapAlias.trim().length > 0) {
        const mapped = voiceMapAlias.trim()
        modelEntry = resolveModelAlias(ctx.serveConfig, mapped)
        if (modelEntry) {
          resolvedAlias = mapped
          matchMode = 'voice_map'
        }
      }
      if (!modelEntry) {
        modelEntry = resolveModelAlias(ctx.serveConfig, aliasKey)
        if (modelEntry) {
          resolvedAlias = aliasKey
          matchMode = 'hyphen'
        }
      }
      if (!modelEntry) {
        modelEntry =
          resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)
        if (modelEntry) {
          resolvedAlias = modelName
          matchMode = 'model'
        }
      }
      if (!modelEntry) {
        throw new HttpError(
          404,
          'model_not_found',
          `Model "${modelName}" with voice "${voice}" is not available. Add a "${aliasKey}" alias, a "${modelName}" alias, or map this voice under serve.openai.audio.speech.voices to a model alias.`
        )
      }

      const endpointCategory =
        'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
      if (endpointCategory !== 'speech') {
        throw new HttpError(
          400,
          'invalid_model_type',
          `Model "${modelName}" does not support speech synthesis.`
        )
      }

      const ttsEngine = modelEntry.config?.['ttsEngine']
      if (
        streamFormat === 'sse' &&
        typeof ttsEngine === 'string' &&
        BATCH_ONLY_TTS_ENGINES.has(ttsEngine)
      ) {
        throw new HttpError(
          400,
          'unsupported_stream_format',
          `Model "${modelName}" (ttsEngine "${ttsEngine}") is batch-only. Use stream_format "audio".`
        )
      }

      const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
      const registryEntry = await ensureReady(ctx, alias, modelEntry, modelName, reply)

      const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
      const ignoredParams: string[] = []
      for (const key of SPEECH_UNSUPPORTED_PARAMS) {
        if ((body as Record<string, unknown>)[key] !== undefined) ignoredParams.push(key)
      }

      ctx.logger.info(
        `  speech model=${alias} voice=${voice} format=${formatMapping.format} chars=${input.length} ` +
          `stream=${streamFormat} route=${matchMode} resolved_alias=${resolvedAlias}`
      )

      if (streamFormat === 'sse') {
        await streamSpeech(req, reply, {
          sdkModelId,
          input,
          format: formatMapping.format === 'pcm' ? 'pcm' : 'wav',
          fallbackSampleRate: resolveSampleRate(registryEntry.config),
          ignoredParams,
          ...(openai.textToSpeechStreamOverride !== undefined
            ? { streamFn: openai.textToSpeechStreamOverride }
            : {})
        })
        return
      }

      const result = textToSpeech({
        modelId: sdkModelId,
        text: input,
        inputType: 'text',
        stream: true
      })
      // A client that disconnects mid-synthesis should stop the engine, not
      // just stop receiving — same binding completions and transcriptions use.
      req.bindCancel(result.requestId)

      const samples: number[] = []
      for await (const sample of result.bufferStream) samples.push(sample)
      await result.done

      // The engine reports the rate it actually emitted. Fall back to the
      // config heuristic only when the run produced no audio, since that
      // table cannot know about `outputSampleRate` or the LavaSR enhancer.
      const sampleRate = (await result.sampleRate) ?? resolveSampleRate(registryEntry.config)

      if (samples.length === 0) {
        ctx.logger.warn(`  speech empty model=${alias} voice=${voice} chars=${input.length}`)
        throw new HttpError(502, 'speech_empty', 'Speech synthesis returned no audio samples.')
      }

      let audioBytes: Buffer
      let contentType: string
      if (formatMapping.kind === 'transcoded') {
        const wav = buildWavBuffer(samples, sampleRate)
        try {
          audioBytes = await transcodeWav(wav, formatMapping.format)
        } catch (err) {
          if (err instanceof AudioEncodeTimeoutError) {
            ctx.logger.error(
              `  speech encode model=${alias} format=${formatMapping.format} timed out: ${err.message}`
            )
            throw new HttpError(
              502,
              'transcode_failed',
              `${err.message}. Retry with response_format=wav or pcm.`
            )
          }
          if (err instanceof AudioEncodeFailedError) {
            const stderrTail = err.stderr.trim().split('\n').slice(-5).join(' | ')
            ctx.logger.error(
              `  speech encode model=${alias} format=${formatMapping.format} ffmpeg exit=${err.exitCode ?? '?'} stderr: ${stderrTail || '(empty)'}`
            )
            throw new HttpError(
              502,
              'transcode_failed',
              `${err.message}. Retry with response_format=wav or pcm.`
            )
          }
          throw err
        }
        contentType = formatMapping.contentType
      } else {
        audioBytes =
          formatMapping.format === 'wav'
            ? buildWavBuffer(samples, sampleRate)
            : int16SamplesToBuffer(samples)
        contentType =
          formatMapping.format === 'pcm' ? pcmContentType(sampleRate) : formatMapping.contentType
      }

      ctx.logger.info(
        `  speech done samples=${samples.length} bytes=${audioBytes.length} sample_rate=${sampleRate}`
      )

      reply.header('Content-Type', contentType).header('Content-Length', audioBytes.length)
      // X-Audio-* describe raw PCM geometry; only meaningful for the native
      // wav/pcm bodies. Encoded containers carry their own rate/channel metadata.
      if (formatMapping.kind === 'native') {
        reply
          .header('X-Audio-Sample-Rate', String(sampleRate))
          .header('X-Audio-Channels', '1')
          .header('X-Audio-Bits-Per-Sample', '16')
      }
      if (ignoredParams.length > 0) {
        reply.header('X-QVAC-Ignored-Params', ignoredParams.join(','))
      }
      reply.send(audioBytes)
    }
  )

  app.get(
    '/v1/audio/voices',
    {
      schema: {
        tags: ['Audio'],
        summary: 'List TTS voices',
        description: descriptions.voices,
        response: { 200: voicesListResponse }
      }
    },
    // lunte-disable-next-line require-await
    async () => {
      const speech = openaiOptions(app.qvac.serveConfig).audio.speech
      const data = collectVoices(speech.voices, speech.defaultVoice)
      return { object: 'list' as const, voices: data.map((v) => v.id), data }
    }
  )

  app.get(
    '/v1/audio/models',
    {
      schema: { tags: ['Audio'], summary: 'List TTS models', description: descriptions.models }
    },
    // lunte-disable-next-line require-await
    async () => ({
      object: 'list' as const,
      // All configured speech models, loaded or not — each lazy-loads on first
      // request, so they must appear here (e.g. Open WebUI's TTS selector) the
      // same way they appear in `/v1/models`.
      data: [...app.qvac.serveConfig.models.values()]
        .filter((entry) => entry.endpointCategory === 'speech')
        .map((entry) => toModelObject(app, entry.alias))
    })
  )
}

function toModelObject(
  app: FastifyInstance,
  alias: string
): {
  id: string
  object: 'model'
  created: number
  owned_by: string
} {
  const entry = app.qvac.registry.getEntry(alias)
  const createdMs = entry?.createdAt ?? Date.now()
  return {
    id: alias,
    object: 'model',
    created: Math.floor(createdMs / 1000),
    owned_by: 'qvac'
  }
}

interface StreamSpeechOptions {
  sdkModelId: string
  input: string
  format: 'wav' | 'pcm'
  fallbackSampleRate: number
  ignoredParams: string[]
  streamFn?: typeof textToSpeechStream
}

async function streamSpeech(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: StreamSpeechOptions
): Promise<void> {
  const logger = req.server.qvac.logger
  const session = await (opts.streamFn ?? textToSpeechStream)({
    modelId: opts.sdkModelId,
    inputType: 'text'
  })
  req.bindCancel(session.requestId)
  session.write(opts.input)
  session.end()

  const frames = session[Symbol.asyncIterator]()
  // Headers wait for the first audio so engine failures and empty runs still
  // get a JSON error with a real status code.
  const first = await nextAudioFrame(frames)
  if (first === null) {
    logger.warn(`  speech empty stream chars=${opts.input.length}`)
    throw new HttpError(502, 'speech_empty', 'Speech synthesis returned no audio samples.')
  }

  const sampleRate = first.sampleRate ?? opts.fallbackSampleRate
  initSSE(reply, {
    'X-Audio-Sample-Rate': String(sampleRate),
    'X-Audio-Channels': '1',
    'X-Audio-Bits-Per-Sample': '16',
    ...(opts.ignoredParams.length > 0
      ? { 'X-QVAC-Ignored-Params': opts.ignoredParams.join(',') }
      : {})
  })
  const raw = reply.raw

  let samples = first.buffer.length
  const firstPcm = int16SamplesToBuffer(first.buffer)
  const firstChunk =
    opts.format === 'wav'
      ? Buffer.concat([buildStreamingWavHeader(sampleRate), firstPcm])
      : firstPcm
  sendSSE(raw, { type: 'speech.audio.delta', audio: firstChunk.toString('base64') })

  // Fastify drops errors thrown after hijack, so a failure here has to end
  // the stream itself or the client would hang.
  try {
    for (let frame = await nextAudioFrame(frames); frame; frame = await nextAudioFrame(frames)) {
      samples += frame.buffer.length
      sendSSE(raw, {
        type: 'speech.audio.delta',
        audio: int16SamplesToBuffer(frame.buffer).toString('base64')
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`  speech stream failed after samples=${samples}: ${message}`)
    sendSSE(raw, { error: { message, type: 'server_error', code: 'internal_error' } })
    endSSE(raw, { sentinel: false })
    return
  }

  // Local synthesis has no billable tokens; OpenAI's schema still requires usage.
  sendSSE(raw, {
    type: 'speech.audio.done',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  })
  endSSE(raw, { sentinel: false })
  logger.info(`  speech stream done samples=${samples} sample_rate=${sampleRate}`)
}

// Next frame that carries audio, or null once the run ends.
async function nextAudioFrame(
  frames: AsyncIterator<TextToSpeechStreamResponse>
): Promise<TextToSpeechStreamResponse | null> {
  for (;;) {
    const next = await frames.next()
    if (next.done) return null
    if (next.value.buffer.length > 0) return next.value
    if (next.value.done) return null
  }
}

interface TranscriptionInvocationOptions {
  modelId: string
  audioChunk: string
  prompt?: string
  hotwords?: string[]
  maxNewTokens?: number
}

interface TranscriptionInvocationResult {
  text: string
  segments?: TranscribeSegment[]
}

async function invokeTranscription(
  req: FastifyRequest,
  transcribeOverride: OpenAIState['transcribeOverride'],
  options: TranscriptionInvocationOptions,
  timed: boolean,
  operation: 'transcription' | 'translation'
): Promise<TranscriptionInvocationResult> {
  if (timed) {
    const op =
      transcribeOverride?.({ ...options, metadata: true }) ??
      transcribe({ ...options, metadata: true })
    req.bindCancel(op.requestId)
    const result = await op
    if (!Array.isArray(result)) {
      throw new HttpError(
        500,
        'internal_error',
        `Timed ${operation} returned text instead of segment metadata.`
      )
    }
    return {
      text: result
        .map((segment) => segment.text)
        .join('')
        .trim(),
      segments: result
    }
  }

  const op = transcribeOverride?.(options) ?? transcribe(options)
  req.bindCancel(op.requestId)
  const result = await op
  if (typeof result !== 'string') {
    const label = operation === 'transcription' ? 'Transcription' : 'Translation'
    throw new HttpError(500, 'internal_error', `${label} returned invalid text.`)
  }
  return { text: result }
}

// Build the voice catalog from the configured voice→alias map plus the default
// voice. Map keys are already lowercased at parse time; the default voice keeps
// its configured casing. Deduplicated, insertion order preserved.
function collectVoices(
  voices: Record<string, string> | null,
  defaultVoice: string | null
): VoiceObject[] {
  const out: VoiceObject[] = []
  const seen = new Set<string>()
  const add = (name: string, model: string | null): void => {
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: name, object: 'audio.voice', model })
  }
  if (voices) {
    for (const [name, alias] of Object.entries(voices)) add(name, alias)
  }
  if (defaultVoice) add(defaultVoice, null)
  return out
}

function assertKnownTranscriptionFormat(responseFormat: string): void {
  if (!SUPPORTED_TRANSCRIPTION_FORMATS.has(responseFormat)) {
    throw new HttpError(
      400,
      'invalid_response_format',
      `Unknown response_format "${responseFormat}". Use "json", "text", "srt", "vtt", or "verbose_json".`
    )
  }
}

function assertTimedFormatSupported(responseFormat: string, sdkType: string): void {
  if (!isTimedTranscriptionFormat(responseFormat)) return
  if (
    responseFormat === 'verbose_json' &&
    (sdkType === 'parakeet' || sdkType === 'parakeet-transcription')
  ) {
    return
  }
  if (
    sdkType === 'whisper' ||
    sdkType === 'whispercpp-transcription' ||
    sdkType === 'moss-transcribe'
  ) {
    return
  }
  throw new HttpError(
    400,
    'unsupported_response_format',
    `response_format "${responseFormat}" requires Whisper or MOSS segment metadata. Use "json" or "text" with this model.`
  )
}

// A custom voice reference `{ id }` routes the same way as a bare name.
function resolveVoice(raw: SpeechVoice | undefined, fallback: string | null): string | null {
  const name = typeof raw === 'object' ? raw.id : raw
  const trimmed = name?.trim()
  return trimmed ? trimmed : fallback
}

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a'
}

// Returns the temp file path for an audio buffer. The caller is responsible
// for deleting it (typically in a finally block).
async function writeTempAudio(
  audio: Buffer,
  fileMeta: { filename: string; mimetype: string } | undefined
): Promise<string> {
  const originalName = fileMeta?.filename ?? ''
  const ext = extname(originalName) || MIME_TO_EXT[fileMeta?.mimetype ?? ''] || '.bin'
  const tmpPath = join(tmpdir(), `qvac-audio-${randomBytes(8).toString('hex')}${ext}`)
  await writeFile(tmpPath, audio)
  return tmpPath
}

export default plugin
