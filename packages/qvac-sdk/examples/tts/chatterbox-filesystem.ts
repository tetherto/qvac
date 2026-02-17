import { loadModel, textToSpeech, unloadModel } from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Chatterbox TTS requires five model artifact sources + reference audio WAV (path or URL).
// Pass as args: <modelSrc> <tokenizerSrc> <speechEncoderSrc> <embedTokensSrc> <conditionalDecoderSrc> <languageModelSrc> <referenceAudioSrc>
const [
  modelSrc,
  ttsTokenizerSrc,
  ttsSpeechEncoderSrc,
  ttsEmbedTokensSrc,
  ttsConditionalDecoderSrc,
  ttsLanguageModelSrc,
  referenceAudioSrc,
] = process.argv.slice(2);

if (
  !modelSrc ||
  !ttsTokenizerSrc ||
  !ttsSpeechEncoderSrc ||
  !ttsEmbedTokensSrc ||
  !ttsConditionalDecoderSrc ||
  !ttsLanguageModelSrc ||
  !referenceAudioSrc
) {
  console.error(
    "Usage: node chatterbox-filesystem.js <modelSrc> <ttsTokenizerSrc> <ttsSpeechEncoderSrc> <ttsEmbedTokensSrc> <ttsConditionalDecoderSrc> <ttsLanguageModelSrc> <referenceAudioSrc>",
  );
  process.exit(1);
}

const CHATTERBOX_SAMPLE_RATE = 24000;

try {
  const modelId = await loadModel({
    modelSrc,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsTokenizerSrc,
      ttsSpeechEncoderSrc,
      ttsEmbedTokensSrc,
      ttsConditionalDecoderSrc,
      ttsLanguageModelSrc,
      referenceAudioSrc,
    },
    onProgress: (progress) => {
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
