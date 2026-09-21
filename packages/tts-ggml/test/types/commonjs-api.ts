import TTSGgml = require('../../index')
import DefaultTTSGgml, {
  ERR_CODES,
  QvacErrorAddonTTSGgml,
  type RuntimeStats,
  type TTSGgmlOptions,
  type TTSOutputChunk
} from '../../index'
import addonLogging = require('../../addonLogging')
import { splitTtsText, type SplitTtsTextOptions } from '../../lib/textChunker'
import {
  accumulateTextStream,
  type TextStreamAccumulatorOptions
} from '../../lib/textStreamAccumulator'

const options: TTSGgmlOptions = {
  engine: TTSGgml.ENGINE_CHATTERBOX,
  config: { language: 'en', useGPU: false },
  logger: {},
  opts: new Date()
}
const namespaceOptions: TTSGgml.TTSGgmlOptions = options
const requireConstructor: typeof TTSGgml = TTSGgml
const defaultConstructor: typeof TTSGgml = DefaultTTSGgml
const model = new TTSGgml(namespaceOptions)
const output: TTSOutputChunk = {
  outputArray: new Int16Array(0)
}
const publicOutputBuffer: Int16Array = output.outputArray
const publicErrorCode: number = ERR_CODES.FAILED_TO_LOAD
const publicErrorConstructor: typeof QvacErrorAddonTTSGgml = QvacErrorAddonTTSGgml
declare const runtimeStats: RuntimeStats
const enhancerBackendDevice: number | undefined = runtimeStats.enhancerBackendDevice
const enhancerBackendId: number | undefined = runtimeStats.enhancerBackendId
type HasPerCallOutputSampleRate =
  'outputSampleRate' extends keyof TTSGgml.TTSRunInput ? false : true
const excludesPerCallOutputSampleRate: HasPerCallOutputSampleRate = true
const publicLogger: object = model.logger
const publicOptions: object = model.opts
const publicAddon: unknown = model.addon
model.logger = {}
model.opts = {}
model.addon = { customAddon: true }
void model.reload({ customRuntimeOption: true })
const chunkOptions: SplitTtsTextOptions = { maxScalars: 100 }
const accumulatorOptions: TextStreamAccumulatorOptions = {
  sentenceDelimiterPreset: 'multilingual'
}

addonLogging.setLogger((_priority, _message) => {})
splitTtsText('Hello.', chunkOptions)
accumulateTextStream(
  (async function* textSource() {
    yield 'Hello.'
  })(),
  accumulatorOptions
)

void [
  requireConstructor,
  defaultConstructor,
  model,
  output,
  publicOutputBuffer,
  publicErrorCode,
  publicErrorConstructor,
  runtimeStats,
  enhancerBackendDevice,
  enhancerBackendId,
  excludesPerCallOutputSampleRate,
  publicLogger,
  publicOptions,
  publicAddon,
  TTSGgml.ENGINE_SUPERTONIC
]
