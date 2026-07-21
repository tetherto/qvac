import TTSGgml = require("../../index");
import DefaultTTSGgml, {
  type TTSGgmlOptions,
  type TTSOutputChunk,
} from "../../index";
import addonLogging = require("../../addonLogging");
import {
  splitTtsText,
  type SplitTtsTextOptions,
} from "../../lib/textChunker";
import {
  accumulateTextStream,
  type TextStreamAccumulatorOptions,
} from "../../lib/textStreamAccumulator";

const options: TTSGgmlOptions = {
  engine: TTSGgml.ENGINE_CHATTERBOX,
  config: { language: "en", useGPU: false },
  logger: {},
  opts: new Date(),
};
const namespaceOptions: TTSGgml.TTSGgmlOptions = options;
const requireConstructor: typeof TTSGgml = TTSGgml;
const defaultConstructor: typeof TTSGgml = DefaultTTSGgml;
const model = new TTSGgml(namespaceOptions);
const output: TTSOutputChunk = {
  outputArray: new ArrayBuffer(0),
};
const publicOutputBuffer: ArrayBuffer = output.outputArray;
const publicLogger: object = model.logger;
const publicOptions: object = model.opts;
const publicAddon: unknown = model.addon;
model.logger = {};
model.opts = {};
model.addon = { customAddon: true };
void model.reload({ customRuntimeOption: true });
const chunkOptions: SplitTtsTextOptions = { maxScalars: 100 };
const accumulatorOptions: TextStreamAccumulatorOptions = {
  sentenceDelimiterPreset: "multilingual",
};

addonLogging.setLogger((_priority, _message) => {});
splitTtsText("Hello.", chunkOptions);
accumulateTextStream(
  (async function* textSource() {
    yield "Hello.";
  })(),
  accumulatorOptions,
);

void [
  requireConstructor,
  defaultConstructor,
  model,
  output,
  publicOutputBuffer,
  publicLogger,
  publicOptions,
  publicAddon,
  TTSGgml.ENGINE_SUPERTONIC,
];
