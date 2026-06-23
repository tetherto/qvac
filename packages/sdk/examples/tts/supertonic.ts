import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Supertonic 3 TTS (GGML): fast multilingual synthesis with baked-in voices.
// Uses registry model constants — downloads automatically from QVAC Registry.
const SUPERTONIC_SAMPLE_RATE = 44100;

try {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      voice: "F1",
      ttsSpeed: 1.05,
      ttsNumInferenceSteps: 5
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  console.log(`▸ Model loaded: ${modelId}`);

  console.log("▸ Testing Text-to-Speech...");
  const result = textToSpeech({
    modelId,
    text: `QVAC SDK is the canonical entry point to QVAC. Written in TypeScript, it provides all QVAC capabilities through a unified interface while also abstracting away the complexity of running your application in a JS environment other than Bare. Supported JS environments include Bare, Node.js, Expo and Bun.`,
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`);

  console.log("▸ Saving audio to file...");
  createWav(audioBuffer, SUPERTONIC_SAMPLE_RATE, "supertonic-output.wav");
  console.log("▸ Audio saved to supertonic-output.wav");

  console.log("▸ Playing audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, SUPERTONIC_SAMPLE_RATE),
    audioData,
  ]);
  playAudio(wavBuffer);
  console.log("▸ Audio playback complete");

  await unloadModel({ modelId });
  console.log("▸ Model unloaded");
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
