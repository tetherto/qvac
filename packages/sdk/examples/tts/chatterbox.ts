import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_T3_TURBO_EN_CHATTERBOX_Q4_0,
  TTS_S3GEN_EN_CHATTERBOX,
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
  // English Chatterbox (turbo) GGUF assets pulled from the registry. The T3
  // GGUF is treated as the primary model; the s3gen decoder is loaded as a
  // companion artifact. Voice cloning uses the user-supplied reference WAV.
  const modelId = await loadModel({
    modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q4_0.src,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsT3ModelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q4_0.src,
      ttsS3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
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
