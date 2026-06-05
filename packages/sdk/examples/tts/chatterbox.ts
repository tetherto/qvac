import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  TTS_S3GEN_EN_CHATTERBOX,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Chatterbox TTS (GGML): voice cloning with optional reference audio.
// Uses registry model constants — downloads automatically from QVAC Registry.
// Usage: node chatterbox.ts [referenceAudioSrc]
const [referenceAudioSrc] = process.argv.slice(2);

const CHATTERBOX_SAMPLE_RATE = 24000;

try {
  const modelId = await loadModel({
    modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
      ...(referenceAudioSrc ? { referenceAudioSrc } : {}),
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
