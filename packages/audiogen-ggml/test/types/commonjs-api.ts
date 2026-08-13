import {
  AudioGen,
  ERR_CODES,
  QvacErrorAudioGen,
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

void audioGen
void errorCode
void errorConstructor
void output
