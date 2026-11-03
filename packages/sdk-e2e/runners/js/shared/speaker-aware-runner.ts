import { transcribe } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/test-suite'

export async function runSpeakerAware(
  modelId: string,
  audioPath: string,
  mode: string,
  expectation: Expectation
): Promise<TestResult> {
  try {
    if (mode === 'metadata') {
      const segments = await transcribe({ modelId, audioChunk: audioPath, metadata: true })
      const turns = segments.flatMap(
        (segment) =>
          segment.speakerSegments ??
          (segment.speakerId === undefined
            ? []
            : [
                {
                  speakerId: segment.speakerId,
                  startMs: segment.startMs,
                  endMs: segment.endMs
                }
              ])
      )
      if (
        turns.length === 0 ||
        turns.some(
          (turn) =>
            !Number.isInteger(turn.speakerId) ||
            turn.speakerId < 0 ||
            turn.speakerId > 7 ||
            !Number.isFinite(turn.startMs) ||
            !Number.isFinite(turn.endMs) ||
            turn.startMs < 0 ||
            turn.endMs <= turn.startMs ||
            turn.endMs > 28000
        )
      ) {
        return { passed: false, output: `Invalid speaker turns: ${JSON.stringify(turns)}` }
      }
      // This fixed 27-second recording has two speakers and speech near its start and end.
      if (!turns.some((turn) => turn.startMs < 1000) || !turns.some((turn) => turn.endMs > 24000)) {
        return {
          passed: false,
          output: `Speaker turns do not cover the fixture: ${JSON.stringify(turns)}`
        }
      }
      return ValidationHelpers.validate(
        segments.map((segment) => segment.text).join(' ') +
          ' ' +
          turns.map((turn) => `speaker:${turn.speakerId}`).join(' '),
        expectation
      )
    }
    const result = await transcribe({
      modelId,
      audioChunk: audioPath,
      ...(mode === 'empty-hotwords' ? { hotwords: [] } : {}),
      ...(mode === 'conflicting-prompt'
        ? { prompt: 'Transcribe this recording.', hotwords: ['QVAC'] }
        : {}),
      ...(mode === 'hotwords' ? { hotwords: ['QVAC'] } : {})
    })
    if (expectation.validation === 'throws-error') {
      return { passed: false, output: 'Expected the invalid request to be rejected' }
    }
    return ValidationHelpers.validate(result, expectation)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (expectation.validation === 'throws-error')
      return ValidationHelpers.validate(message, expectation)
    return { passed: false, output: message }
  }
}
