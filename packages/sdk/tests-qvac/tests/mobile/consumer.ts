import { createExecutor } from "@tetherto/qvac-test-suite/mobile";
import {
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  PARAKEET_TDT_ENCODER_INT8,
  PARAKEET_TDT_DECODER_INT8,
  PARAKEET_TDT_PREPROCESSOR_INT8,
  PARAKEET_TDT_VOCAB,
  PARAKEET_CTC_FP32,
  PARAKEET_CTC_DATA_FP32,
  PARAKEET_CTC_TOKENIZER,
  PARAKEET_SORTFORMER_FP32,
} from "@qvac/sdk";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { MobileTranscriptionExecutor } from "./executors/transcription-executor.js";
import { MobileParakeetExecutor } from "./executors/parakeet-executor.js";

const resources = new ResourceManager();

resources.define("llm", {
  constant: LLAMA_3_2_1B_INST_Q4_0,
  type: "llm",
  config: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
});

resources.define("embeddings", {
  constant: GTE_LARGE_FP16,
  type: "embeddings",
});

resources.define("whisper", {
  constant: WHISPER_TINY,
  type: "whisper",
  config: {
    vadModelSrc: VAD_SILERO_5_1_2,
    audio_format: "f32le",
    strategy: "greedy",
    language: "en",
    translate: false,
    no_timestamps: false,
    single_segment: false,
    temperature: 0.0,
    suppress_blank: true,
    suppress_nst: true,
    vad_params: {
      threshold: 0.35,
      min_speech_duration_ms: 200,
      min_silence_duration_ms: 150,
      max_speech_duration_s: 30.0,
      speech_pad_ms: 600,
      samples_overlap: 0.3,
    },
  },
});

// Parakeet TDT 0.6B (INT8) — multilingual speech-to-text (~700MB)
resources.define("parakeet-tdt", {
  constant: PARAKEET_TDT_ENCODER_INT8,
  type: "parakeet",
  skipPreDownload: true,
  config: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_INT8,
  },
});

// Parakeet CTC FP32 — streaming-capable speech-to-text
resources.define("parakeet-ctc", {
  constant: PARAKEET_CTC_FP32,
  type: "parakeet",
  skipPreDownload: true,
  config: {
    modelType: "ctc",
    parakeetCtcModelSrc: PARAKEET_CTC_FP32,
    parakeetCtcModelDataSrc: PARAKEET_CTC_DATA_FP32,
    parakeetTokenizerSrc: PARAKEET_CTC_TOKENIZER,
  },
});

// Parakeet Sortformer — speaker diarization
resources.define("parakeet-sortformer", {
  constant: PARAKEET_SORTFORMER_FP32,
  type: "parakeet",
  skipPreDownload: true,
  config: {
    modelType: "sortformer",
    parakeetSortformerSrc: PARAKEET_SORTFORMER_FP32,
  },
});

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(resources),
    new MobileTranscriptionExecutor(resources),
    new MobileParakeetExecutor(resources),
  ],
});
