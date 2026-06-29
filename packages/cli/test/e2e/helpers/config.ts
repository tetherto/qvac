import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { tempDir } from './tmp.js'

// A config with a single non-preloaded model. Enough to exercise every
// validation path (routing, schema, auth, CORS, 404/400) without loading
// anything.
export const MODELLESS_CONFIG = {
  serve: {
    models: {
      'fake-transcribe': {
        type: 'whispercpp-transcription',
        src: 'hyper://example.invalid/model',
        preload: false
      }
    }
  }
} as const

// Write a qvac.config.json into a throwaway dir and return its path as a
// projectRoot. Cleanup is registered on the test context.
export async function writeConfigDir(t: TestContext, config: unknown): Promise<string> {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'qvac.config.json'), JSON.stringify(config))
  return dir
}

// Small real models (LLM, embedding, Whisper) that load over P2P from the
// registry, with stable aliases the real-model tests reference.
export const E2E = {
  llm: 'test-llm',
  embed: 'test-embed',
  whisper: 'test-whisper',
  whisperTranslate: 'test-whisper-translate',
  video: 'test-video'
} as const

export const MODEL_CONFIG = {
  serve: {
    models: {
      'test-llm': { model: 'QWEN3_600M_INST_Q4', preload: true, config: { ctx_size: 2048 } },
      'test-embed': { model: 'EMBEDDINGGEMMA_300M_Q4_0', preload: true },
      'test-whisper': { model: 'WHISPER_EN_TINY_Q8_0', preload: true },
      'test-whisper-translate': {
        model: 'WHISPER_EN_TINY_Q8_0',
        type: 'whispercpp-audio-translation',
        preload: true
      },
      'test-video': { src: 'placeholder', type: 'sdcpp-video', preload: false }
    }
  }
} as const

// Just the LLM — for the spawned-server streaming/cancel fidelity tests, to
// avoid reloading the full set in a second process.
export const LLM_ONLY_CONFIG = {
  serve: {
    models: {
      'test-llm': { model: 'QWEN3_600M_INST_Q4', preload: true, config: { ctx_size: 2048 } }
    }
  }
} as const
