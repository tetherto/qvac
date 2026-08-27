import type { AudioGenClientParams, AudioGenConfig, AudioGenEngine } from '@/index'

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
