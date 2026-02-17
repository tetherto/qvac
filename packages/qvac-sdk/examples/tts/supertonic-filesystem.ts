import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Supertonic TTS: general-purpose, no voice cloning. Pass paths in order: tokenizer, text_encoder, latent_denoiser, voice_decoder, voice.bin
// Usage: node supertonic-filesystem.js <ttsTokenizerSrc> <ttsTextEncoderSrc> <ttsLatentDenoiserSrc> <ttsVoiceDecoderSrc> <ttsVoiceSrc>
const [
  ttsTokenizerSrc,
  ttsTextEncoderSrc,
  ttsLatentDenoiserSrc,
  ttsVoiceDecoderSrc,
  ttsVoiceSrc,
] = process.argv.slice(2);

if (
  !ttsTokenizerSrc ||
  !ttsTextEncoderSrc ||
  !ttsLatentDenoiserSrc ||
  !ttsVoiceDecoderSrc ||
  !ttsVoiceSrc
) {
  console.error(
    "Usage: node supertonic-filesystem.js <ttsTokenizerSrc> <ttsTextEncoderSrc> <ttsLatentDenoiserSrc> <ttsVoiceDecoderSrc> <ttsVoiceSrc>",
  );
  process.exit(1);
}

const modelSrc = ttsTokenizerSrc;
const SUPERTONIC_SAMPLE_RATE = 44100;

try {
  const modelId = await loadModel({
    modelSrc,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      ttsTokenizerSrc,
      ttsTextEncoderSrc,
      ttsLatentDenoiserSrc,
      ttsVoiceDecoderSrc,
      ttsVoiceSrc,
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
  console.log(`TTS complete. Total samples: ${audioBuffer.length}`);

  console.log("💾 Saving audio to file...");
  createWav(audioBuffer, SUPERTONIC_SAMPLE_RATE, "supertonic-output.wav");
  console.log("✅ Audio saved to supertonic-output.wav");

  console.log("🔊 Playing audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, SUPERTONIC_SAMPLE_RATE),
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
