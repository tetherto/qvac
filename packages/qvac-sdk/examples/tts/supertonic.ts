import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_TOKENIZER_SUPERTONIC,
  TTS_TEXT_ENCODER_SUPERTONIC_FP32,
  TTS_LATENT_DENOISER_SUPERTONIC_FP32,
  TTS_VOICE_DECODER_SUPERTONIC_FP32,
  TTS_VOICE_STYLE_SUPERTONIC,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Supertonic TTS: general-purpose, no voice cloning.
// Uses registry model constants - downloads automatically from QVAC Registry.
const SUPERTONIC_SAMPLE_RATE = 44100;

try {
  const modelId = await loadModel({
    modelSrc: TTS_TOKENIZER_SUPERTONIC.src,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      ttsTokenizerSrc: TTS_TOKENIZER_SUPERTONIC.src,
      ttsTextEncoderSrc: TTS_TEXT_ENCODER_SUPERTONIC_FP32.src,
      ttsLatentDenoiserSrc: TTS_LATENT_DENOISER_SUPERTONIC_FP32.src,
      ttsVoiceDecoderSrc: TTS_VOICE_DECODER_SUPERTONIC_FP32.src,
      ttsVoiceSrc: TTS_VOICE_STYLE_SUPERTONIC.src,
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
