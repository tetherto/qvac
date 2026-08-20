import {
  AudioEditOperationType,
  AudioGen,
  ERR_CODES,
  QvacErrorAudioGen,
  RepaintMode,
  type AudiogenOutputChunk
} from '../../index'

const audioGen = new AudioGen()
const errorCode: number = ERR_CODES.INVALID_INPUT
const errorConstructor: typeof QvacErrorAudioGen = QvacErrorAudioGen
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
void output
void editSession
void editResponse
void operationType
