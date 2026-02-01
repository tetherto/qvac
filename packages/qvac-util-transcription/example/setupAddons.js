'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')

const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')

const bitRate = 128000

async function setupModelStore ({
  driveKey = 'ebfb94b378276da139554668f1ff737644eadff529c2ea0f2662d7df61fd86ca',
  storePath = './store',
  hdNamespace = 'hd'
}) {
  const store = new Corestore(storePath)
  const hdStore = store.namespace(hdNamespace)
  const hdDL = new HyperDriveDL({ key: `hd://${driveKey}`, store: hdStore })
  return { store, hdDL }
}

function createWhisperAddonWithVad (hdDL) {
  const whisperArgs = {
    loader: hdDL,
    modelName: 'ggml-tiny.bin',
    diskPath: './models'
  }

  // Config object contains whisper configuration, VAD settings, and misc options
  const whisperConfig = {
    vadModelPath: './models/ggml-silero-v5.1.2.bin',
    whisperConfig: {
      language: 'en',
      temperature: 0.0,
      vad_params: {
        threshold: 0.6,
        min_speech_duration_ms: 500,
        min_silence_duration_ms: 300,
        max_speech_duration_s: 15.0,
        speech_pad_ms: 100,
        samples_overlap: 0.2
      }
    },
    contextParams: {
      use_gpu: false
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  return new TranscriptionWhispercpp(whisperArgs, whisperConfig)
}

module.exports = {
  bitRate,
  setupModelStore,
  createWhisperAddonWithVad
}
