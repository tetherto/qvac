import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_TOKENIZER_EN_CHATTERBOX,
  TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32,
  TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32,
  TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32,
  TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32,
  TTS_ENHANCER_BACKBONE_LAVASR_FP32,
  TTS_ENHANCER_SPEC_HEAD_LAVASR_FP32,
  TTS_DENOISER_LAVASR_FP32,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// A/B comparison: Chatterbox TTS with and without LavaSR neural speech enhancement.
// Produces two WAV files so you can hear the difference.
// Usage: node chatterbox-enhanced.js <referenceAudioSrc>
// LavaSR models are loaded from the QVAC Registry automatically.
const [referenceAudioSrc] = process.argv.slice(2);

if (!referenceAudioSrc) {
  console.error("Usage: node chatterbox-enhanced.js <referenceAudioSrc>");
  process.exit(1);
}

const CHATTERBOX_SAMPLE_RATE = 24000;
const ENHANCED_SAMPLE_RATE = 48000;
const SYNTHESIS_TEXT =
  "Hello! This sentence is synthesized twice, once at standard quality and once with LavaSR neural enhancement, so you can hear the difference.";

const chatterboxConfig = {
  ttsEngine: "chatterbox" as const,
  language: "en" as const,
  ttsTokenizerSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
  ttsSpeechEncoderSrc: TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32.src,
  ttsEmbedTokensSrc: TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32.src,
  ttsConditionalDecoderSrc: TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32.src,
  ttsLanguageModelSrc: TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32.src,
  referenceAudioSrc,
};

function onProgress(progress: ModelProgressUpdate) {
  console.log(progress);
}

function saveAndPlay(samples: number[], sampleRate: number, filename: string) {
  createWav(samples, sampleRate, filename);
  console.log(`Saved ${filename}`);
  const audioData = int16ArrayToBuffer(samples);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, sampleRate),
    audioData,
  ]);
  playAudio(wavBuffer);
}

try {
  // --- Pass 1: Raw Chatterbox (no enhancer) ---
  console.log("\n--- Pass 1: Raw Chatterbox (24 kHz) ---\n");

  const rawModelId = await loadModel({
    modelSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
    modelType: "tts",
    modelConfig: chatterboxConfig,
    onProgress,
  });

  const rawResult = textToSpeech({
    modelId: rawModelId,
    text: SYNTHESIS_TEXT,
    inputType: "text",
    stream: false,
  });

  const rawBuffer = await rawResult.buffer;
  console.log(`Raw TTS complete. ${rawBuffer.length} samples @ ${CHATTERBOX_SAMPLE_RATE} Hz`);
  saveAndPlay(rawBuffer, CHATTERBOX_SAMPLE_RATE, "tts-raw-output.wav");

  await unloadModel({ modelId: rawModelId });
  console.log("Raw model unloaded.\n");

  // --- Pass 2: Chatterbox + LavaSR enhancement ---
  console.log("--- Pass 2: Chatterbox + LavaSR enhancement (48 kHz) ---\n");

  const enhancedModelId = await loadModel({
    modelSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
    modelType: "tts",
    modelConfig: {
      ...chatterboxConfig,
      enhancer: {
        type: "lavasr",
        enhance: true,
        denoise: true,
        backboneSrc: TTS_ENHANCER_BACKBONE_LAVASR_FP32.src,
        specHeadSrc: TTS_ENHANCER_SPEC_HEAD_LAVASR_FP32.src,
        denoiserSrc: TTS_DENOISER_LAVASR_FP32.src,
      },
    },
    onProgress,
  });

  const enhancedResult = textToSpeech({
    modelId: enhancedModelId,
    text: SYNTHESIS_TEXT,
    inputType: "text",
    stream: false,
  });

  const enhancedBuffer = await enhancedResult.buffer;
  console.log(`Enhanced TTS complete. ${enhancedBuffer.length} samples @ ${ENHANCED_SAMPLE_RATE} Hz`);
  saveAndPlay(enhancedBuffer, ENHANCED_SAMPLE_RATE, "tts-enhanced-output.wav");

  await unloadModel({ modelId: enhancedModelId });
  console.log("Enhanced model unloaded.");

  console.log("\n--- Done ---");
  console.log("Compare the two files:");
  console.log("  tts-raw-output.wav      -- 24 kHz standard Chatterbox");
  console.log("  tts-enhanced-output.wav -- 48 kHz with LavaSR enhancement");

  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
