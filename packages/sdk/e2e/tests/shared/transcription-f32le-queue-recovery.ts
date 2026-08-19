import { transcribe } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/qvac-test-suite'
import { decodeWavToMonoF32, f32ToLeBytes, type DecodedPcm } from './wav-pcm.js'

const WHISPER_SAMPLE_RATE = 16000
const INCOMPLETE_F32LE_STREAM_ERROR = 'f32le byte stream ends mid-sample'

interface MaterializedF32leAudio {
  validPath: string
  malformedPath: string
  cleanup(): Promise<void>
}

type MaterializeF32leAudio = (
  validAudio: Uint8Array,
  malformedAudio: Uint8Array
) => Promise<MaterializedF32leAudio>

function downsampleToWhisperRate(
  samples: Float32Array,
  sourceSampleRate: number
): Float32Array | null {
  if (sourceSampleRate === WHISPER_SAMPLE_RATE) return samples
  if (sourceSampleRate < WHISPER_SAMPLE_RATE || sourceSampleRate % WHISPER_SAMPLE_RATE !== 0) {
    return null
  }

  const samplesPerOutput = sourceSampleRate / WHISPER_SAMPLE_RATE
  const output = new Float32Array(Math.floor(samples.length / samplesPerOutput))

  for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
    const sourceStart = outputIndex * samplesPerOutput
    let sum = 0
    for (let offset = 0; offset < samplesPerOutput; offset++) {
      sum += samples[sourceStart + offset] ?? 0
    }
    output[outputIndex] = sum / samplesPerOutput
  }

  return output
}

export async function runF32leQueueRecovery(
  modelId: string,
  wavBytes: Uint8Array,
  expectation: Expectation,
  materializeAudio: MaterializeF32leAudio
): Promise<TestResult> {
  let decoded: DecodedPcm
  try {
    decoded = decodeWavToMonoF32(wavBytes)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { passed: false, output: `Failed to decode WAV fixture: ${errorMessage}` }
  }

  const samples = downsampleToWhisperRate(decoded.samplesMono, decoded.sampleRate)
  if (!samples) {
    return {
      passed: false,
      output:
        `Unsupported WAV sample rate ${decoded.sampleRate}; ` +
        `expected ${WHISPER_SAMPLE_RATE} Hz or an integer multiple`
    }
  }

  const validAudio = f32ToLeBytes(samples)
  const malformedAudio = validAudio.slice(0, -1)
  const files = await materializeAudio(validAudio, malformedAudio)

  try {
    let malformedError: string | null = null
    try {
      await transcribe({
        modelId,
        audioChunk: files.malformedPath
      })
    } catch (error) {
      malformedError = error instanceof Error ? error.message : String(error)
    }

    if (malformedError === null) {
      return {
        passed: false,
        output: 'Malformed f32le transcription unexpectedly succeeded'
      }
    }
    if (!malformedError.includes(INCOMPLETE_F32LE_STREAM_ERROR)) {
      return {
        passed: false,
        output:
          `Malformed f32le transcription returned the wrong error: ${malformedError}; ` +
          `expected to contain "${INCOMPLETE_F32LE_STREAM_ERROR}"`
      }
    }

    const recoveredText = await transcribe({
      modelId,
      audioChunk: files.validPath
    })

    return ValidationHelpers.validate(recoveredText.trim(), expectation)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      passed: false,
      output: `Valid f32le transcription did not recover: ${errorMessage}`
    }
  } finally {
    await files.cleanup()
  }
}
