import { textToSpeech } from '@qvac/sdk'

type ParlerParams = {
  text: string
  description?: string
  voiceDescription?: string
  voice?: string
  emotion?: string
  pitch?: string
  pace?: string
  expressivity?: string
  noise?: string
  reverb?: string
  quality?: string
}

type ParlerEmotionComparisonParams = {
  text: string
  voice?: string
  firstEmotion: string
  secondEmotion: string
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

function buildParlerRequest(modelId: string, params: ParlerParams) {
  return {
    modelId,
    text: params.text,
    inputType: 'text' as const,
    stream: false as const,
    description: params.description,
    voiceDescription: params.voiceDescription,
    voice: params.voice,
    emotion: params.emotion,
    pitch: params.pitch,
    pace: params.pace,
    expressivity: params.expressivity,
    noise: params.noise,
    reverb: params.reverb,
    quality: params.quality
  }
}

async function synthesize(modelId: string, params: ParlerParams) {
  const result = textToSpeech(buildParlerRequest(modelId, params) as never)
  return await result.buffer
}

function buffersDiffer(first: Float32Array, second: Float32Array) {
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
    const modelId = await dependencies.ensureLoaded(dependencies.dependency)

    try {
      const buffer = await synthesize(modelId, params)
      const sampleCount = buffer?.length ?? 0

      if (expectation.validation === 'throws-error') {
        return {
          passed: false,
          output: 'Expected Parler validation error but synthesis succeeded'
        } as TResult
      }
      if (sampleCount === 0) {
        return { passed: false, output: 'Parler produced no audio samples' } as TResult
      }

      return dependencies.validate(`parler-generated ${sampleCount} samples`, expectation)
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
        voice: params.voice,
        emotion: params.firstEmotion
      })
      const second = await synthesize(modelId, {
        text: params.text,
        voice: params.voice,
        emotion: params.secondEmotion
      })
      const firstSamples = first?.length ?? 0
      const secondSamples = second?.length ?? 0

      if (!first || !second || firstSamples === 0 || secondSamples === 0) {
        return {
          passed: false,
          output: `Parler conditioning produced empty audio (first=${firstSamples}, second=${secondSamples})`
        } as TResult
      }
      if (!buffersDiffer(first, second)) {
        return {
          passed: false,
          output: 'Parler emotion changes produced identical PCM output'
        } as TResult
      }

      return dependencies.validate(
        `emotion-conditioning-verified ${firstSamples}+${secondSamples} samples`,
        expectation
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Parler conditioning failed: ${errorMessage}` } as TResult
    }
  }
}
