import { Readable } from 'bare-stream'
import { QvacResponse } from '@qvac/response'
import { FFmpegDecoder } from '@qvac/decoder-audio'

interface TranscriptionPipelineConfig {
  sampleRate?: number
  audioFormat?: 'decoded' | 'encoded' | 's16le' | 'f32le'
}

interface TranscriptionPipelineAddons {
  whisperAddon: any
  decoder?: FFmpegDecoder
}

declare class TranscriptionPipeline {
  constructor(
    addons: TranscriptionPipelineAddons,
    config?: TranscriptionPipelineConfig
  )

  /**
   * Load all provided components.
   * @param closeLoader - Whether to close the loader after loading
   * @param reportProgress - Callback function to report loading progress
   */
  load(
    closeLoader?: boolean,
    reportProgress?: (progress: number) => void
  ): Promise<void>

  /**
   * Unload all provided components.
   */
  unload(): Promise<void>

  /**
   * Run the pipeline on an input audio stream.
   * @param audioStream - Input audio stream
   * @returns Streaming transcription response
   */
  run(audioStream: Readable): Promise<QvacResponse>

  /**
   * Pause currently running inference if any
   */
  pause(): Promise<void>

  /**
   * Continue running if any
   */
  unpause(): Promise<void>

  /**
   * Stops currently running inference if any
   */
  stop(): Promise<void>

  /**
   * Current status of the inference addon
   */
  status(): Promise<String>

  /**
   * Identifies which model API should be used on current environment
   */
  getApiDefinition(): string
}

export = TranscriptionPipeline
