import { textToSpeech } from '@qvac/sdk'

interface TtsHandlerParams {
  text: string
}

interface TtsTestResult {
  passed: boolean
  output: string
}

interface TtsHandlerOptions<Expectation, Result extends TtsTestResult> {
  ensureLoaded: (dependency: string) => Promise<string>
  validate: (output: string, expectation: Expectation) => Result
}

interface EnhancedTtsHandlerOptions<
  Expectation,
  Result extends TtsTestResult
> extends TtsHandlerOptions<Expectation, Result> {
  dependency: string
}

type TtsResult = ReturnType<typeof textToSpeech>

export async function countTtsSamples(modelId: string, text: string) {
  const result: TtsResult = textToSpeech({
    modelId,
    text,
    inputType: 'text',
    stream: false
  })
  const audioBuffer = await result.buffer
  return audioBuffer?.length ?? 0
}

// LavaSR enhancer + denoiser happy path: the enhancer forces 48 kHz internally,
// but that rate isn't observable through the public TTS result, so assert the
// two-stage chain produces a non-empty buffer end to end.
export function makeEnhancedTtsHandler<Expectation, Result extends TtsTestResult>({
  dependency,
  ensureLoaded,
  validate
}: EnhancedTtsHandlerOptions<Expectation, Result>) {
  return async (params: TtsHandlerParams, expectation: Expectation): Promise<Result> => {
    const modelId = await ensureLoaded(dependency)

    try {
      const samples = await countTtsSamples(modelId, params.text)
      if (samples === 0) {
        return {
          passed: false,
          output: 'LavaSR enhanced synthesis produced no audio (0 samples)'
        } as Result
      }
      return validate(`LavaSR enhanced synthesis produced ${samples} samples`, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `TTS enhanced error: ${errorMsg}` } as Result
    }
  }
}

// outputSampleRate happy path: run the same text through the native-rate
// (44.1 kHz) and 8 kHz Supertonic resources. Sample count scales with the
// rate, so native must produce far more samples (~5.5x). A >=3x floor clears
// any per-load duration jitter while still proving the 8 kHz resample took
// effect. Only the ratio-pass branch emits `outputSampleRate-verified`.
export function makeOutputSampleRateComparisonHandler<Expectation, Result extends TtsTestResult>({
  ensureLoaded,
  validate
}: TtsHandlerOptions<Expectation, Result>) {
  return async (params: TtsHandlerParams, expectation: Expectation): Promise<Result> => {
    const nativeId = await ensureLoaded('tts-supertonic')
    const downId = await ensureLoaded('tts-supertonic-8k')

    try {
      const nativeSamples = await countTtsSamples(nativeId, params.text)
      const downSamples = await countTtsSamples(downId, params.text)

      if (nativeSamples === 0 || downSamples === 0) {
        return {
          passed: false,
          output: `outputSampleRate comparison produced empty audio (native=${nativeSamples}, down=${downSamples})`
        } as Result
      }

      const ratio = nativeSamples / downSamples
      if (ratio < 3) {
        return {
          passed: false,
          output: `outputSampleRate ratio too low: native/down=${ratio.toFixed(2)} (native=${nativeSamples} @44100, down=${downSamples} @8000)`
        } as Result
      }

      return validate(
        `outputSampleRate-verified: native=${nativeSamples} @44100 vs down=${downSamples} @8000 (ratio ${ratio.toFixed(2)}, samples compared)`,
        expectation
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `TTS outputSampleRate error: ${errorMsg}` } as Result
    }
  }
}
