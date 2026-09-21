import { textToSpeech, textToSpeechStream } from '@qvac/sdk'

// Audio8 takes no per-request voice conditioning: emotion, pace, and
// description fields are rejected for this engine, so only the text and the
// requested operation shape the synthesis.
type Audio8Params = {
  text: string
  operation?: 'batch' | 'stream' | 'sentence-stream' | 'duplex'
}

type TtsTestResult = {
  passed: boolean
  output: string
}

type HandlerDependencies<TExpectation, TResult extends TtsTestResult> = {
  dependency: string
  ensureLoaded: (dependency: string) => Promise<string>
  validate: (output: string, expectation: TExpectation) => TResult
}

const MIN_AUDIO_SAMPLES = 4096
const MIN_PEAK_AMPLITUDE = 1e-4

function buildAudio8Request(modelId: string, params: Audio8Params) {
  return {
    modelId,
    text: params.text,
    inputType: 'text' as const,
    stream: false as const
  }
}

async function synthesize(modelId: string, params: Audio8Params) {
  const result = textToSpeech(buildAudio8Request(modelId, params))
  return await result.buffer
}

async function synthesizeStream(modelId: string, params: Audio8Params) {
  const result = textToSpeech({
    ...buildAudio8Request(modelId, params),
    stream: true
  })
  const buffer: number[] = []
  for await (const sample of result.bufferStream) {
    buffer.push(sample)
  }
  if (!(await result.done)) {
    throw new Error('Audio8 stream ended without a done frame')
  }
  return buffer
}

async function synthesizeSentenceStream(modelId: string, params: Audio8Params) {
  const result = textToSpeech({
    ...buildAudio8Request(modelId, params),
    stream: true,
    sentenceStream: true
  })
  if (!result.chunkUpdates) {
    throw new Error('Audio8 sentence stream did not expose chunk updates')
  }

  const buffer: number[] = []
  let chunks = 0
  for await (const chunk of result.chunkUpdates) {
    for (const sample of chunk.buffer) buffer.push(sample)
    chunks++
  }
  if (!(await result.done) || chunks === 0) {
    throw new Error(`Audio8 sentence stream ended without completed chunks (${chunks})`)
  }
  return buffer
}

async function synthesizeDuplex(modelId: string, params: Audio8Params) {
  const session = await textToSpeechStream({
    modelId,
    inputType: 'text'
  })
  session.write(params.text)
  session.end()

  const buffer: number[] = []
  for await (const response of session) {
    for (const sample of response.buffer) buffer.push(sample)
    if (response.done) break
  }
  return buffer
}

async function synthesizeForOperation(modelId: string, params: Audio8Params) {
  if (params.operation === 'stream') return synthesizeStream(modelId, params)
  if (params.operation === 'sentence-stream') return synthesizeSentenceStream(modelId, params)
  if (params.operation === 'duplex') return synthesizeDuplex(modelId, params)
  return synthesize(modelId, params)
}

function audioValidationError(buffer: number[]) {
  if (buffer.length < MIN_AUDIO_SAMPLES) {
    return `produced only ${buffer.length} samples (minimum ${MIN_AUDIO_SAMPLES})`
  }

  let peak = 0
  for (const sample of buffer) {
    peak = Math.max(peak, Math.abs(sample))
  }
  if (peak < MIN_PEAK_AMPLITUDE) {
    return `produced silent audio (peak=${peak})`
  }

  return undefined
}

export function makeAudio8TtsHandler<
  TExpectation extends { validation: string },
  TResult extends TtsTestResult
>(dependencies: HandlerDependencies<TExpectation, TResult>) {
  return async (params: Audio8Params, expectation: TExpectation): Promise<TResult> => {
    try {
      if (expectation.validation === 'throws-error') {
        await synthesize('schema-validation-only', params)
        return {
          passed: false,
          output: 'Expected Audio8 validation error but synthesis succeeded'
        } as TResult
      }

      const modelId = await dependencies.ensureLoaded(dependencies.dependency)
      const buffer = await synthesizeForOperation(modelId, params)
      const sampleCount = buffer.length
      const validationError = audioValidationError(buffer)

      if (validationError) {
        return { passed: false, output: `Audio8 ${validationError}` } as TResult
      }

      return dependencies.validate(
        `audio8-generated operation=${params.operation ?? 'batch'} ${sampleCount} samples`,
        expectation
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (expectation.validation === 'throws-error') {
        return dependencies.validate(errorMessage, expectation)
      }
      return { passed: false, output: `Audio8 TTS failed: ${errorMessage}` } as TResult
    }
  }
}
