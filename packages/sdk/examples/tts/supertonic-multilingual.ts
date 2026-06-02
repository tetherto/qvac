import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_MULTILINGUAL_SUPERTONIC2_Q8_0,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Supertonic 2 TTS (GGML): multilingual synthesis (en/ko/es/pt/fr).
const SUPERTONIC_SAMPLE_RATE = 44100;

try {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC2_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "es",
      voice: "F1",
      ttsSpeed: 1.05,
      ttsNumInferenceSteps: 5,
    },
    onProgress: (progress: ModelProgressUpdate) => {
      console.log(progress);
    },
  });

  console.log(`Model loaded: ${modelId}`);

  console.log("🎵 Testing Text-to-Speech...");
  const result = textToSpeech({
    modelId,
    text: `Hola mundo. Esta es una demostración de síntesis de voz con Supertonic en español.`,
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`TTS complete. Total samples: ${audioBuffer.length}`);

  console.log("💾 Saving audio to file...");
  createWav(
    audioBuffer,
    SUPERTONIC_SAMPLE_RATE,
    "supertonic-multilingual-output.wav",
  );
  console.log("✅ Audio saved to supertonic-multilingual-output.wav");

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
