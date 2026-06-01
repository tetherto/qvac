import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { transcribe, textToSpeech } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { multipartToBody } from '../lib/multipart.js'
import { resolveAndCheckModel } from '../plugins/require-model.js'
import { logUnsupported } from '../plugins/log-unsupported.js'
import { transcriptionsBody, translationsBody, audioSpeechBody, SPEECH_UNSUPPORTED_PARAMS } from '../schemas/audio.js'
import { resolveModelAlias } from '../config.js'
import {
  buildWavBuffer,
  int16SamplesToBuffer,
  mapResponseFormat,
  pcmContentType,
  resolveSampleRate,
  speechAliasKey
} from '../audio.js'
import type { ModelEntry, ResolvedModelEntry } from '../core/model-registry.js'

const SUPPORTED_TRANSCRIPTION_FORMATS = new Set(['json', 'text'])
const UNSUPPORTED_TRANSCRIPTION_FORMATS = new Set(['srt', 'vtt', 'verbose_json'])

const descriptions = {
  transcribe: `
Speech-to-text via Whisper-cpp / Parakeet. Multipart body with required
\`file\` (audio bytes) and \`model\` (alias of a registered transcription
model).

**\`response_format\`** accepts only \`json\` (default) and \`text\`.
\`srt\`, \`vtt\`, and \`verbose_json\` return \`400 unsupported_response_format\`
(timestamps and segment metadata are not exposed). Unknown values return
\`400 invalid_response_format\`.

**\`language\`** is honored as a model-load-time config, not per request.
Sending it logs a warning and uses whatever language the model was loaded
with.

**\`temperature\`** is logged as ignored.

**Validation order**: \`Content-Type\` must be multipart → schema (file + model
required) → param checks (response_format) → model resolution → SDK call.
`.trim(),
  translate: `
Speech-to-English-text via a Whisper translation model. Multipart body, same
required fields as transcriptions.

**Output is always English** — the underlying capability is fixed. Sending a
\`language\` field returns \`400 unsupported_param\`.

Same \`response_format\` rules as transcriptions
(\`json\`/\`text\` accepted; \`srt\`/\`vtt\`/\`verbose_json\` rejected).

The model must be registered with sdkType
\`whispercpp-audio-translation\` (i.e. \`endpointCategory: 'audio-translation'\`)
— a plain transcription model is rejected with \`invalid_model_type\`.
`.trim(),
  speech: `
Synthesize speech from \`input\` text. **The response is raw audio bytes**
(not JSON) with the appropriate \`Content-Type\` (\`audio/wav\`,
\`audio/x-pcm\`, etc.) and \`X-Audio-Sample-Rate\` / \`X-Audio-Channels\` /
\`X-Audio-Bits-Per-Sample\` headers.

**Model lookup is voice-aware** (multi-stage): the server first checks the
\`serve.openai.audio.speech.voices\` map (\`voice → alias\`), then a hyphen
alias (\`{model}-{voice}\`), then the bare \`model\`. If no candidate
resolves, the error message lists all three lookup keys it tried.

**\`voice\`** is required unless \`serve.openai.audio.speech.defaultVoice\` is
configured (default: \`"alloy"\`).

**\`input_too_long\`** is returned when \`input.length\` exceeds
\`serve.openai.audio.speech.maxInputChars\` (default 4096). Whitespace-only
input is rejected as \`missing_input\`.

**\`response_format\`** accepts engine-native formats (wav, pcm, raw). MP3,
opus, aac, flac return \`unsupported_response_format\` (no transcoder).

**Ignored params** (logged, returned in \`X-QVAC-Ignored-Params\` header):
\`speed\`, \`instructions\`, \`stream_format\`.
`.trim()
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/audio/transcriptions', {
    schema: {
      body: transcriptionsBody,
      tags: ['Audio'],
      summary: 'Audio transcription',
      description: descriptions.transcribe,
      consumes: ['multipart/form-data']
    },
    preValidation: multipartToBody
  }, async (req, reply) => {
    const body = req.body
    const file = body.file as Buffer
    const fileMeta = req.multipartFiles?.find((f) => f.fieldname === 'file')
    const responseFormat = (body.response_format as string | undefined) ?? 'json'

    assertSupportedTextFormat(responseFormat)
    if (body.language !== undefined) {
      app.qvac.logger.warn(`language="${String(body.language)}" is configured at model load time. Per-request language override is not yet supported.`)
    }
    if (body.temperature !== undefined) {
      app.qvac.logger.warn(`Ignoring unsupported param: temperature=${String(body.temperature)}`)
    }

    const { sdkModelId, alias } = resolveAndCheckModel(req, String(body.model), 'transcription')
    const fileSizeKB = Math.round(file.length / 1024)
    app.qvac.logger.info(
      `  transcribe model=${alias} file=${fileMeta?.filename ?? ''} size=${fileSizeKB}KB ` +
      `format=${responseFormat}${body.prompt ? ' prompt=yes' : ''}`
    )

    const transcribeFn = app.qvac.transcribeOverride ?? transcribe
    const op = transcribeFn({
      modelId: sdkModelId,
      audioChunk: file,
      ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {})
    })
    req.bindCancel(op.requestId)
    const text = await op
    app.qvac.logger.info(`  transcribe done chars=${text.length}`)

    if (responseFormat === 'text') {
      reply.type('text/plain').send(text)
      return
    }
    return { text }
  })

  app.post('/v1/audio/translations', {
    schema: {
      body: translationsBody,
      tags: ['Audio'],
      summary: 'Audio translation (to English)',
      description: descriptions.translate,
      consumes: ['multipart/form-data']
    },
    preValidation: multipartToBody
  }, async (req, reply) => {
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
    assertSupportedTextFormat(responseFormat)
    if (body.temperature !== undefined) {
      app.qvac.logger.warn(`Ignoring unsupported param: temperature=${String(body.temperature)}`)
    }

    const { sdkModelId, alias } = resolveAndCheckModel(req, String(body.model), 'audio-translation')
    const fileSizeKB = Math.round(file.length / 1024)
    app.qvac.logger.info(
      `  translate model=${alias} file=${fileMeta?.filename ?? ''} size=${fileSizeKB}KB ` +
      `format=${responseFormat}${body.prompt ? ' prompt=yes' : ''}`
    )

    const transcribeFn = app.qvac.transcribeOverride ?? transcribe
    const op = transcribeFn({
      modelId: sdkModelId,
      audioChunk: file,
      ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {})
    })
    req.bindCancel(op.requestId)
    const text = await op
    app.qvac.logger.info(`  translate done chars=${text.length}`)

    if (responseFormat === 'text') {
      reply.type('text/plain').send(text)
      return
    }
    return { text }
  })

  app.post('/v1/audio/speech', {
    schema: {
      body: audioSpeechBody,
      tags: ['Audio'],
      summary: 'Text-to-speech',
      description: descriptions.speech
    },
    config: { unsupportedParams: [...SPEECH_UNSUPPORTED_PARAMS] },
    preHandler: logUnsupported
  }, async (req, reply) => {
    const body = req.body
    const modelName = body.model.trim()
    const input = body.input
    const ctx = app.qvac

    // Zod min(1) lets whitespace-only through; legacy treats it as empty.
    if (!input.trim()) {
      throw new HttpError(400, 'missing_input', '"input" is required and must be a non-empty string.')
    }

    const maxInputChars = ctx.serveConfig.openai.audio.speech.maxInputChars
    if (maxInputChars !== null && input.length > maxInputChars) {
      throw new HttpError(
        400,
        'input_too_long',
        `"input" exceeds the configured limit of ${maxInputChars} characters (got ${input.length}). ` +
        'Raise serve.openai.audio.speech.maxInputChars or split the request.'
      )
    }

    const voice = resolveVoice(body.voice, ctx.serveConfig.openai.audio.speech.defaultVoice)
    if (voice === null) {
      throw new HttpError(400, 'missing_voice', '"voice" is required (no default voice configured).')
    }

    const formatMapping = mapResponseFormat(body.response_format)
    if (formatMapping.kind === 'unsupported') {
      throw new HttpError(400, 'unsupported_response_format', formatMapping.message)
    }
    if (formatMapping.kind === 'invalid') {
      throw new HttpError(400, 'invalid_response_format', formatMapping.message)
    }

    // voice_map → hyphen alias → bare model (multi-stage lookup).
    const aliasKey = speechAliasKey(modelName, voice)
    const voiceKey = voice.toLowerCase()
    const voiceMapAlias = ctx.serveConfig.openai.audio.speech.voices?.[voiceKey] ?? null

    let modelEntry: ResolvedModelEntry | ModelEntry | null = null
    let resolvedAlias = ''
    let matchMode: 'voice_map' | 'hyphen' | 'model' = 'model'

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
      modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)
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

    const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
    if (endpointCategory !== 'speech') {
      throw new HttpError(400, 'invalid_model_type', `Model "${modelName}" does not support speech synthesis.`)
    }

    const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
    const registryEntry = ctx.registry.getEntry(alias)
    if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
      throw new HttpError(503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    }

    const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
    const sampleRate = resolveSampleRate(registryEntry.config)
    const ignoredParams: string[] = []
    for (const key of SPEECH_UNSUPPORTED_PARAMS) {
      if ((body as Record<string, unknown>)[key] !== undefined) ignoredParams.push(key)
    }

    ctx.logger.info(
      `  speech model=${alias} voice=${voice} format=${formatMapping.format} chars=${input.length} ` +
      `route=${matchMode} resolved_alias=${resolvedAlias}`
    )

    const result = textToSpeech({
      modelId: sdkModelId,
      text: input,
      inputType: 'text',
      stream: true
    })

    const samples: number[] = []
    for await (const sample of result.bufferStream) samples.push(sample)
    await result.done

    if (samples.length === 0) {
      ctx.logger.warn(`  speech empty model=${alias} voice=${voice} chars=${input.length}`)
      throw new HttpError(502, 'speech_empty', 'Speech synthesis returned no audio samples.')
    }

    const audioBytes = formatMapping.format === 'wav'
      ? buildWavBuffer(samples, sampleRate)
      : int16SamplesToBuffer(samples)
    const contentType = formatMapping.format === 'pcm'
      ? pcmContentType(sampleRate)
      : formatMapping.contentType

    ctx.logger.info(`  speech done samples=${samples.length} bytes=${audioBytes.length} sample_rate=${sampleRate}`)

    reply
      .header('Content-Type', contentType)
      .header('Content-Length', audioBytes.length)
      .header('X-Audio-Sample-Rate', String(sampleRate))
      .header('X-Audio-Channels', '1')
      .header('X-Audio-Bits-Per-Sample', '16')
    if (ignoredParams.length > 0) {
      reply.header('X-QVAC-Ignored-Params', ignoredParams.join(','))
    }
    reply.send(audioBytes)
  })
}

function assertSupportedTextFormat (responseFormat: string): void {
  if (UNSUPPORTED_TRANSCRIPTION_FORMATS.has(responseFormat)) {
    throw new HttpError(400, 'unsupported_response_format', `response_format "${responseFormat}" is not supported. Use "json" or "text".`)
  }
  if (!SUPPORTED_TRANSCRIPTION_FORMATS.has(responseFormat)) {
    throw new HttpError(400, 'invalid_response_format', `Unknown response_format "${responseFormat}". Use "json" or "text".`)
  }
}

function resolveVoice (raw: unknown, fallback: string | null): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length > 0) return trimmed
  }
  return fallback
}

export default plugin
