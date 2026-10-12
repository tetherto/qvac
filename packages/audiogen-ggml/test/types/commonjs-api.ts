import {
  AudioEditOperationType,
  AudioGen,
  ENGINE_MINIMAX,
  ERR_CODES,
  QvacErrorAudioGen,
  RepaintMode,
  assessFit,
  detectEngineType,
  type AudioGenEngine,
  type AudiogenFitRequest,
  type AudiogenFitStatus,
  type AudiogenGenerationMetadata,
  type AudiogenMinimaxDevice,
  type AudiogenOutputChunk,
  type AudiogenStats
} from '../../index'

type InvalidEngineIsAllowed =
  'invalid-engine' extends Parameters<typeof detectEngineType>[1] ? true : false

const audioGen = new AudioGen()
const errorCode: number = ERR_CODES.INVALID_INPUT
const errorConstructor: typeof QvacErrorAudioGen = QvacErrorAudioGen
const engine: AudioGenEngine = ENGINE_MINIMAX
const invalidEngineIsAllowed: InvalidEngineIsAllowed = false
const minimax = new AudioGen({
  engine,
  files: {
    lmModel: '/models/mm3-lm.gguf',
    synthModel: '/models/mm3-synth.gguf'
  }
})
const output: AudiogenOutputChunk = {
  outputArray: new Int16Array(0),
  sampleRate: 48000,
  channels: 2
}
const editSession = audioGen
  .edit({
    pcm: new Int16Array([0, 0]),
    sampleRate: 48000,
    channels: 2
  })
  .edit({
    from: { caption: 'original pop' },
    to: { caption: 'guitar pop-rock' }
  })
  .repaint({
    caption: 'analog synth solo',
    start: 0,
    end: 1,
    mode: RepaintMode.Balanced
  })
const operationType: AudioEditOperationType =
  AudioEditOperationType.FlowEdit
const editResponse = editSession.run({
  seed: 22883,
  referenceAudio: new Float32Array(2),
  vocalLanguage: 'en',
  bpm: 120,
  keyscale: 'C major',
  timesignature: '4/4',
  augmentCaptionWithMetadata: true,
  dcwEnabled: false,
  dcwScaler: 0.05,
  dcwHighScaler: 0.02,
  inferenceSteps: 8,
  shift: 3
})
const device: AudiogenMinimaxDevice = 'gpu'
const strictMinimax = new AudioGen({
  engine: ENGINE_MINIMAX,
  files: { modelDir: '/models/minimax' },
  config: { device }
})
const perRunSchedule = audioGen.run('lo-fi', { inferenceSteps: 12, shift: 2.5 })
const minimaxFit: AudiogenFitRequest = {
  engine: ENGINE_MINIMAX,
  lmPath: '/models/mm3-lm.gguf',
  synthPath: '/models/mm3-synth.gguf',
  device,
  maxFrames: 300,
  promptTokens: 900
}
const minimaxVerdict: AudiogenFitStatus = assessFit(minimaxFit).status
function readMetadata(stats: AudiogenStats): number | undefined {
  const metadata: AudiogenGenerationMetadata | undefined = stats.metadata
  return metadata === undefined
    ? stats.emittedFrames
    : metadata.seed + metadata.beatsPerBar + metadata.codeFrames
}

void audioGen
void errorCode
void errorConstructor
void minimax
void output
void invalidEngineIsAllowed
void editSession
void editResponse
void strictMinimax
void perRunSchedule
void minimaxVerdict
void readMetadata
void operationType
