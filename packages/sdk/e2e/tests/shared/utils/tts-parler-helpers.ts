import {
  textToSpeech,
  textToSpeechStream,
  type TtsClientParamsInput,
  type TtsParlerEmotion
} from '@qvac/sdk'

type ParlerVoiceParams = Partial<
  Pick<
    TtsClientParamsInput,
    | 'description'
    | 'voiceDescription'
    | 'voice'
    | 'emotion'
    | 'pitch'
    | 'pace'
    | 'expressivity'
    | 'noise'
    | 'reverb'
    | 'quality'
  >
>

type ParlerParams = ParlerVoiceParams & {
  text: string
  operation?: 'batch' | 'stream' | 'sentence-stream' | 'duplex'
}

type ParlerEmotionComparisonParams = {
  text: string
  voice?: string
  firstEmotion: TtsParlerEmotion
  secondEmotion: TtsParlerEmotion
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

function buildParlerVoiceOptions(params: ParlerVoiceParams) {
  return {
    ...(params.description !== undefined && { description: params.description }),
    ...(params.voiceDescription !== undefined && { voiceDescription: params.voiceDescription }),
    ...(params.voice !== undefined && { voice: params.voice }),
    ...(params.emotion !== undefined && { emotion: params.emotion }),
    ...(params.pitch !== undefined && { pitch: params.pitch }),
    ...(params.pace !== undefined && { pace: params.pace }),
    ...(params.expressivity !== undefined && { expressivity: params.expressivity }),
    ...(params.noise !== undefined && { noise: params.noise }),
    ...(params.reverb !== undefined && { reverb: params.reverb }),
    ...(params.quality !== undefined && { quality: params.quality })
  }
}

function buildParlerRequest(modelId: string, params: ParlerVoiceParams & { text: string }) {
  return {
    modelId,
    text: params.text,
    inputType: 'text' as const,
    stream: false as const,
    ...buildParlerVoiceOptions(params)
  }
}

async function synthesize(modelId: string, params: ParlerParams) {
  const result = textToSpeech(buildParlerRequest(modelId, params))
  return await result.buffer
}

async function synthesizeStream(modelId: string, params: ParlerParams) {
  const result = textToSpeech({
    ...buildParlerRequest(modelId, params),
    stream: true
  })
  const buffer: number[] = []
  for await (const sample of result.bufferStream) {
    buffer.push(sample)
  }
  if (!(await result.done)) {
    throw new Error('Parler stream ended without a done frame')
  }
  return buffer
}

async function synthesizeSentenceStream(modelId: string, params: ParlerParams) {
  const result = textToSpeech({
    ...buildParlerRequest(modelId, params),
    stream: true,
    sentenceStream: true
  })
  if (!result.chunkUpdates) {
    throw new Error('Parler sentence stream did not expose chunk updates')
  }

  const buffer: number[] = []
  let chunks = 0
  for await (const chunk of result.chunkUpdates) {
    for (const sample of chunk.buffer) buffer.push(sample)
    chunks++
  }
  if (!(await result.done) || chunks === 0) {
    throw new Error(`Parler sentence stream ended without completed chunks (${chunks})`)
  }
  return buffer
}

async function synthesizeDuplex(modelId: string, params: ParlerParams) {
  const session = await textToSpeechStream({
    modelId,
    inputType: 'text',
    ...buildParlerVoiceOptions(params)
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

async function synthesizeForOperation(modelId: string, params: ParlerParams) {
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

export function makeParlerTtsHandler<
  TExpectation extends { validation: string },
  TResult extends TtsTestResult
>(dependencies: HandlerDependencies<TExpectation, TResult>) {
  return async (params: ParlerParams, expectation: TExpectation): Promise<TResult> => {
    try {
      if (expectation.validation === 'throws-error') {
        await synthesize('schema-validation-only', params)
        return {
          passed: false,
          output: 'Expected Parler validation error but synthesis succeeded'
        } as TResult
      }

      const modelId = await dependencies.ensureLoaded(dependencies.dependency)
      const buffer = await synthesizeForOperation(modelId, params)
      const sampleCount = buffer.length
      const validationError = audioValidationError(buffer)

      if (validationError) {
        return { passed: false, output: `Parler ${validationError}` } as TResult
      }

      return dependencies.validate(
        `parler-generated operation=${params.operation ?? 'batch'} ${sampleCount} samples`,
        expectation
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (expectation.validation === 'throws-error') {
        return dependencies.validate(errorMessage, expectation)
      }
      return { passed: false, output: `Parler TTS failed: ${errorMessage}` } as TResult
    }
  }
}

export function makeParlerEmotionComparisonHandler<
  TExpectation extends { validation: string },
  TResult extends TtsTestResult
>(dependencies: HandlerDependencies<TExpectation, TResult>) {
  return async (
    params: ParlerEmotionComparisonParams,
    expectation: TExpectation
  ): Promise<TResult> => {
    const modelId = await dependencies.ensureLoaded(dependencies.dependency)

    try {
      const first = await synthesize(modelId, {
        text: params.text,
        ...(params.voice !== undefined && { voice: params.voice }),
        emotion: params.firstEmotion
      })
      const control = await synthesize(modelId, {
        text: params.text,
        ...(params.voice !== undefined && { voice: params.voice }),
        emotion: params.firstEmotion
      })
      const second = await synthesize(modelId, {
        text: params.text,
        ...(params.voice !== undefined && { voice: params.voice }),
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
          output: `Parler conditioning audio invalid (first=${firstError ?? 'ok'}, control=${controlError ?? 'ok'}, second=${secondError ?? 'ok'})`
        } as TResult
      }
      if (buffersDiffer(first, control)) {
        return {
          passed: false,
          output: 'Parler deterministic control runs produced different PCM output'
        } as TResult
      }
      if (!buffersDiffer(first, second)) {
        return {
          passed: false,
          output: 'Parler emotion changes produced identical PCM output'
        } as TResult
      }

      return dependencies.validate(
        `emotion-conditioning-verified ${firstSamples}+${controlSamples}+${secondSamples} samples`,
        expectation
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Parler conditioning failed: ${errorMessage}` } as TResult
    }
  }
}
