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
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Chatterbox TTS: voice cloning with reference audio.
// Uses registry model constants - downloads automatically from QVAC Registry.
// Only reference audio WAV needs to be provided by the user.
// Usage: node chatterbox-filesystem.js <referenceAudioSrc>
const [referenceAudioSrc] = process.argv.slice(2);

if (!referenceAudioSrc) {
  console.error("Usage: node chatterbox-filesystem.js <referenceAudioSrc>");
  process.exit(1);
}

const CHATTERBOX_SAMPLE_RATE = 24000;

try {
  const modelId = await loadModel({
    modelSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsTokenizerSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
      ttsSpeechEncoderSrc: TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32.src,
      ttsEmbedTokensSrc: TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32.src,
      ttsConditionalDecoderSrc: TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32.src,
      ttsLanguageModelSrc: TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32.src,
      referenceAudioSrc,
    },
    onProgress: (progress: ModelProgressUpdate) => {
      console.log(progress);
    },
  });

  console.log(`Model loaded: ${modelId}`);

  console.log("🎵 Testing Text-to-Speech...");
  const result = textToSpeech({
    modelId,
    text: `QVAC SDK is the canonical entry point to QVAC. Written in TypeScript, it provides all QVAC capabilities through a unified interface while also abstracting away the complexity of running your application in a JS environment other than Bare. Supported JS environments include Bare, Node.js, Expo and Bun.`,
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`TTS complete. Total bytes: ${audioBuffer.length}`);

  console.log("💾 Saving audio to file...");
  createWav(audioBuffer, CHATTERBOX_SAMPLE_RATE, "tts-output.wav");
  console.log("✅ Audio saved to tts-output.wav");

  console.log("🔊 Playing audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, CHATTERBOX_SAMPLE_RATE),
    audioData,
  ]);
  playAudio(wavBuffer);
  console.log("✅ Audio playback complete");

  await unloadModel({ modelId });
  console.log("Model unloaded");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
