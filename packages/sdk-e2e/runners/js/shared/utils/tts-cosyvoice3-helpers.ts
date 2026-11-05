import {
  textToSpeech,
  textToSpeechStream,
  type TtsClientParamsInput,
  type TtsCosyvoice3Emotion
} from '@qvac/sdk'

type Cosyvoice3VoiceParams = Partial<Pick<TtsClientParamsInput, 'emotion' | 'pace'>>

type Cosyvoice3Params = Cosyvoice3VoiceParams & {
  text: string
  operation?: 'batch' | 'stream' | 'sentence-stream' | 'duplex'
}

type Cosyvoice3EmotionComparisonParams = {
  text: string
  firstEmotion: TtsCosyvoice3Emotion
  secondEmotion: TtsCosyvoice3Emotion
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

function buildCosyvoice3VoiceOptions(params: Cosyvoice3VoiceParams) {
  return {
    ...(params.emotion !== undefined && { emotion: params.emotion }),
    ...(params.pace !== undefined && { pace: params.pace })
  }
}

function buildCosyvoice3Request(modelId: string, params: Cosyvoice3VoiceParams & { text: string }) {
  return {
    modelId,
    text: params.text,
    inputType: 'text' as const,
    stream: false as const,
    ...buildCosyvoice3VoiceOptions(params)
  }
}

async function synthesize(modelId: string, params: Cosyvoice3Params) {
  const result = textToSpeech(buildCosyvoice3Request(modelId, params))
  return await result.buffer
}

async function synthesizeStream(modelId: string, params: Cosyvoice3Params) {
  const result = textToSpeech({
    ...buildCosyvoice3Request(modelId, params),
    stream: true
  })
  const buffer: number[] = []
  for await (const sample of result.bufferStream) {
    buffer.push(sample)
  }
  if (!(await result.done)) {
    throw new Error('CosyVoice3 stream ended without a done frame')
  }
  return buffer
}

async function synthesizeSentenceStream(modelId: string, params: Cosyvoice3Params) {
  const result = textToSpeech({
    ...buildCosyvoice3Request(modelId, params),
    stream: true,
    sentenceStream: true
  })
  if (!result.chunkUpdates) {
    throw new Error('CosyVoice3 sentence stream did not expose chunk updates')
  }

  const buffer: number[] = []
  let chunks = 0
  for await (const chunk of result.chunkUpdates) {
    for (const sample of chunk.buffer) buffer.push(sample)
    chunks++
  }
  if (!(await result.done) || chunks === 0) {
    throw new Error(`CosyVoice3 sentence stream ended without completed chunks (${chunks})`)
  }
  return buffer
}

async function synthesizeDuplex(modelId: string, params: Cosyvoice3Params) {
  const session = await textToSpeechStream({
    modelId,
    inputType: 'text',
    ...buildCosyvoice3VoiceOptions(params)
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

async function synthesizeForOperation(modelId: string, params: Cosyvoice3Params) {
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

function buffersDiffer(first: number[], second: number[]) {
  if (first.length !== second.length) return true

  for (let index = 0; index < first.length; index++) {
    if (Math.abs(first[index]! - second[index]!) > 1e-7) return true
  }

  return false
}

export function makeCosyvoice3TtsHandler<
  TExpectation extends { validation: string },
  TResult extends TtsTestResult
>(dependencies: HandlerDependencies<TExpectation, TResult>) {
  return async (params: Cosyvoice3Params, expectation: TExpectation): Promise<TResult> => {
    try {
      if (expectation.validation === 'throws-error') {
        await synthesize('schema-validation-only', params)
        return {
          passed: false,
          output: 'Expected CosyVoice3 validation error but synthesis succeeded'
        } as TResult
      }

      const modelId = await dependencies.ensureLoaded(dependencies.dependency)
      const buffer = await synthesizeForOperation(modelId, params)
      const sampleCount = buffer.length
      const validationError = audioValidationError(buffer)

      if (validationError) {
        return { passed: false, output: `CosyVoice3 ${validationError}` } as TResult
      }

      return dependencies.validate(
        `cosyvoice3-generated operation=${params.operation ?? 'batch'} ${sampleCount} samples`,
        expectation
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (expectation.validation === 'throws-error') {
        return dependencies.validate(errorMessage, expectation)
      }
      return { passed: false, output: `CosyVoice3 TTS failed: ${errorMessage}` } as TResult
    }
  }
}

export function makeCosyvoice3EmotionComparisonHandler<
  TExpectation extends { validation: string },
  TResult extends TtsTestResult
>(dependencies: HandlerDependencies<TExpectation, TResult>) {
  return async (
    params: Cosyvoice3EmotionComparisonParams,
    expectation: TExpectation
  ): Promise<TResult> => {
    const modelId = await dependencies.ensureLoaded(dependencies.dependency)

    try {
      const first = await synthesize(modelId, {
        text: params.text,
        emotion: params.firstEmotion
      })
      const control = await synthesize(modelId, {
        text: params.text,
        emotion: params.firstEmotion
      })
      const second = await synthesize(modelId, {
        text: params.text,
        emotion: params.secondEmotion
      })
      const firstSamples = first.length
      const controlSamples = control.length
      const secondSamples = second.length
      const firstError = audioValidationError(first)
      const controlError = audioValidationError(control)
      const secondError = audioValidationError(second)

      if (firstError || controlError || secondError) {
        return {
          passed: false,
          output: `CosyVoice3 conditioning audio invalid (first=${firstError ?? 'ok'}, control=${controlError ?? 'ok'}, second=${secondError ?? 'ok'})`
        } as TResult
      }
      if (buffersDiffer(first, control)) {
        return {
          passed: false,
          output: 'CosyVoice3 deterministic control runs produced different PCM output'
        } as TResult
      }
      if (!buffersDiffer(first, second)) {
        return {
          passed: false,
          output: 'CosyVoice3 emotion changes produced identical PCM output'
        } as TResult
      }

      return dependencies.validate(
        `emotion-conditioning-verified ${firstSamples}+${controlSamples}+${secondSamples} samples`,
        expectation
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `CosyVoice3 conditioning failed: ${errorMessage}` } as TResult
    }
  }
}
