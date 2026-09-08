import type {
  AudioGenClientParams,
  AudioGenConfig,
  AudioGenEngine,
  AudioGenRuntimeConfig
} from '@/index'

const minimaxEngine: AudioGenEngine = 'minimax'
void minimaxEngine

const minimaxConfig: AudioGenConfig = {
  engine: 'minimax',
  lmModelSrc: '/models/minimax-lm.gguf',
  synthModelSrc: '/models/minimax-synth.gguf',
  useGPU: true,
  inferenceSteps: 12,
  cfgScale: 1.8
}
void minimaxConfig

const acestepRuntimeConfig: AudioGenRuntimeConfig = {
  shift: 3,
  nGpuLayers: 99
}
void acestepRuntimeConfig

const minimaxRuntimeConfig: AudioGenRuntimeConfig = {
  engine: 'minimax',
  inferenceSteps: 12,
  cfgScale: 1.8
}
void minimaxRuntimeConfig

const invalidMinimaxRuntimeConfig: AudioGenRuntimeConfig = {
  engine: 'minimax',
  // @ts-expect-error MiniMax rejects ACE-Step-only runtime controls
  shift: 3
}
void invalidMinimaxRuntimeConfig

const invalidAcestepRuntimeConfig: AudioGenRuntimeConfig = {
  engine: 'acestep',
  // @ts-expect-error ACE-Step rejects MiniMax-only cfgScale
  cfgScale: 1.8
}
void invalidAcestepRuntimeConfig

const minimaxRequest: AudioGenClientParams = {
  modelId: 'minimax-model',
  caption: 'warm cinematic piano with gentle strings',
  lyrics: '[Instrumental]',
  maxFrames: 250,
  inferenceSteps: 12,
  cfgScale: 1.8
}
void minimaxRequest

// @ts-expect-error MiniMax requires both model sources
const missingSynthesisModel: AudioGenConfig = {
  engine: 'minimax',
  lmModelSrc: '/models/minimax-lm.gguf'
}
void missingSynthesisModel

// @ts-expect-error unknown AudioGen engines are rejected
const invalidEngine: AudioGenEngine = 'other'
void invalidEngine
