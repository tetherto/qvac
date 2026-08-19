import {
  AudioEditOperationType,
  AudioGen,
  ENGINE_MINIMAX,
  ERR_CODES,
  QvacErrorAudioGen,
  RepaintMode,
  detectEngineType,
  type AudioGenEngine,
  type AudiogenOutputChunk
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
const editResponse = editSession.run({ seed: 22883 })

void audioGen
void errorCode
void errorConstructor
void minimax
void output
void invalidEngineIsAllowed
void editSession
void editResponse
void operationType
