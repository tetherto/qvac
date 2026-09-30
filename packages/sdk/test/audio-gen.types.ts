import type {
  AudioEditClientParams,
  AudioEditOperation,
  AudioEditRepaintOperation,
  AudioGenClientParams,
  AudioGenConfig,
  AudioGenEngine,
  AudioGenRepaintMode,
  AudioGenRuntimeConfig,
  AudioGenTrack,
  AudioGenUnderstandResult,
  AudioUnderstandClientParams
} from '@/index'

const frozenCodes: AudioGenClientParams = {
  modelId: 'acestep-model',
  caption: 'a short piano note',
  augmentCaptionWithMetadata: true,
  audioCodes: new Int32Array([12095, 63487])
}
void frozenCodes

const plainCodes: AudioGenClientParams = {
  modelId: 'acestep-model',
  caption: 'a short piano note',
  audioCodes: [12095, 63487]
}
void plainCodes

const editParams: AudioEditClientParams = {
  modelId: 'acestep-model',
  sourceAudio: '/path/to/song.wav',
  seed: 22883,
  operations: [
    {
      type: 'flow-edit',
      from: { caption: 'original pop song', lyrics: 'la la' },
      to: { caption: 'guitar pop-rock' },
      nMin: 0,
      nMax: 1,
      nAvg: 1
    },
    { type: 'repaint', caption: 'analog synth solo', start: 10, end: 20, mode: 'balanced' }
  ]
}
void editParams

const editFromBytes: AudioEditClientParams = {
  modelId: 'acestep-model',
  sourceAudio: new Uint8Array(8),
  operations: [{ type: 'repaint', caption: 'drum fill', start: 0 }]
}
void editFromBytes

// @ts-expect-error only flow-edit and repaint operations exist
const unknownOperation: AudioEditOperation = { type: 'lego', caption: 'x', start: 0 }
void unknownOperation

// @ts-expect-error repaint requires a start time
const missingStart: AudioEditRepaintOperation = { type: 'repaint', caption: 'x' }
void missingStart

const repaintMode: AudioGenRepaintMode = 'aggressive'
void repaintMode

// @ts-expect-error unknown repaint modes are rejected
const unknownRepaintMode: AudioGenRepaintMode = 'wild'
void unknownRepaintMode

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

const generationControls: AudioGenClientParams = {
  modelId: 'acestep-model',
  caption: 'a rainy-day lo-fi loop',
  lyrics: 'a real verse',
  rewriteQuery: true,
  generateLrc: true,
  computeQualityScore: true,
  normalizeLoudness: false,
  guidanceScale: 7
}
void generationControls

const legoRequest: AudioGenClientParams = {
  modelId: 'acestep-model',
  caption: 'the same song with a busier kit',
  taskType: 'lego',
  track: 'drums',
  sourceAudio: '/path/to/song.wav'
}
void legoRequest

const track: AudioGenTrack = 'backing_vocals'
void track

// @ts-expect-error track is limited to the published instrument vocabulary
const unknownTrack: AudioGenTrack = 'kazoo'
void unknownTrack

const understandFromPath: AudioUnderstandClientParams = {
  modelId: 'acestep-model',
  sourceAudio: '/path/to/song.wav',
  seed: 11,
  vocalLanguage: 'es',
  lmTemperature: 0.7,
  lmTopP: 0.85,
  lmTopK: 40
}
void understandFromPath

const understandFromBytes: AudioUnderstandClientParams = {
  modelId: 'acestep-model',
  sourceAudio: new Uint8Array(8)
}
void understandFromBytes

const understandWithCaption: AudioUnderstandClientParams = {
  modelId: 'acestep-model',
  sourceAudio: '/path/to/song.wav',
  // @ts-expect-error understanding takes no caption: the LM writes one
  caption: 'not a generation'
}
void understandWithCaption

// The codes a description recovers feed straight back into a generation.
declare const recovered: AudioGenUnderstandResult
const reuseRecoveredCodes: AudioGenClientParams = {
  modelId: 'acestep-model',
  caption: recovered.caption,
  audioCodes: recovered.audioCodes
}
void reuseRecoveredCodes
