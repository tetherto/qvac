import { transcribe } from '@qvac/sdk'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from '../abstract-model-executor.js'
import { transcriptionTests } from '../../../transcription-tests.js'
import { runF32leQueueRecovery } from '../../transcription-f32le-queue-recovery.js'
import {
  runMetadataStreamDuplex,
  validateSegments,
  type MetadataStreamOptions
} from '../../transcription-segments.js'

export class TranscriptionExecutor extends AbstractModelExecutor<typeof transcriptionTests> {
  pattern = /^transcription-/

  protected handlers = Object.fromEntries(
    transcriptionTests.map((test) => {
      if (test.testId === 'transcription-f32le-queue-recovery') {
        return [test.testId, this.f32leQueueRecovery.bind(this)]
      }
      if (test.testId === 'transcription-metadata-batch') {
        return [test.testId, this.metadataBatch.bind(this)]
      }
      if (test.testId === 'transcription-metadata-streaming') {
        return [test.testId, this.metadataStreaming.bind(this)]
      }
      return [test.testId, this.generic.bind(this)]
    })
  ) as never

  async f32leQueueRecovery(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string }
    const whisperModelId = await this.resources.ensureLoaded('whisper')
    const audioPath = path.resolve(process.cwd(), 'assets/audio', p.audioFileName)
    const wavBuffer = await fs.readFile(audioPath)
    const wavBytes = new Uint8Array(wavBuffer.buffer, wavBuffer.byteOffset, wavBuffer.byteLength)

    return runF32leQueueRecovery(
      whisperModelId,
      wavBytes,
      expectation as Expectation,
      async (validAudio, malformedAudio) => {
        const directory = await fs.mkdtemp(path.join(tmpdir(), 'qvac-f32le-recovery-'))
        const validPath = path.join(directory, 'valid.f32le')
        const malformedPath = path.join(directory, 'malformed.f32le')

        try {
          await fs.writeFile(validPath, validAudio)
          await fs.writeFile(malformedPath, malformedAudio)
        } catch (error) {
          await fs.rm(directory, { recursive: true, force: true })
          throw error
        }

        return {
          validPath,
          malformedPath,
          cleanup: async () => {
            await fs.rm(directory, { recursive: true, force: true })
          }
        }
      }
    )
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string; timeout?: number; prompt?: string | null }
    const exp = expectation as Expectation
    const whisperModelId = await this.resources.ensureLoaded('whisper')

    const audioPath = path.resolve(process.cwd(), 'assets/audio', p.audioFileName)

    try {
      const transcribeParams: { modelId: string; audioChunk: string; prompt?: string } = {
        modelId: whisperModelId,
        audioChunk: audioPath
      }
      if (p.prompt && typeof p.prompt === 'string' && p.prompt.trim().length > 0) {
        transcribeParams.prompt = p.prompt
      }

      const text = await transcribe(transcribeParams)
      const trimmedText = text.trim()

      if (exp.validation === 'throws-error') {
        return { passed: false, output: 'Expected error but transcription succeeded' }
      }
      return ValidationHelpers.validate(trimmedText, exp)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (exp.validation === 'throws-error') {
        return ValidationHelpers.validate(errorMsg, exp)
      }
      return { passed: false, output: `Transcription failed: ${errorMsg}` }
    }
  }

  async metadataBatch(params: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string }
    const whisperModelId = await this.resources.ensureLoaded('whisper')
    const audioPath = path.resolve(process.cwd(), 'assets/audio', p.audioFileName)

    try {
      const segments = await transcribe({
        modelId: whisperModelId,
        audioChunk: audioPath,
        metadata: true
      })
      return validateSegments(segments)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Metadata batch failed: ${errorMsg}` }
    }
  }

  async metadataStreaming(params: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string } & MetadataStreamOptions
    const whisperModelId = await this.resources.ensureLoaded('whisper')
    const audioPath = path.resolve(process.cwd(), 'assets/audio', p.audioFileName)

    const buf = await fs.readFile(audioPath)
    const audioBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    return runMetadataStreamDuplex(whisperModelId, audioBytes, {
      ...(p.trailingSilenceMs !== undefined && {
        trailingSilenceMs: p.trailingSilenceMs
      }),
      ...(p.chunkMs !== undefined && { chunkMs: p.chunkMs })
    })
  }
}
