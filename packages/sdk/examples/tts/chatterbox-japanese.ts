import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0,
  TTS_S3GEN_MULTILINGUAL_CHATTERBOX,
  TTS_MECAB_IPADIC_CHATTERBOX,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Chatterbox TTS (GGML): Japanese ("ja") synthesis with the multilingual
// (MTL) model. Japanese needs word-level morphological segmentation so
// kanji resolve to phonetic readings instead of [UNK]; tts-cpp does that
// internally and only needs the compiled MeCab/IPAdic dictionary directory,
// which you pass via `mecabDictSrc`.
//
// The dictionary ships in the QVAC registry as a 6-file companion set
// (sys.dic + char.bin/dicrc/matrix.bin/mecabrc/unk.dic), exposed as the
// `TTS_MECAB_IPADIC_CHATTERBOX` constant. Passing its `.src` lets the SDK
// download and colocate all six files and hand the directory to the addon —
// no manual path needed. (You can still pass a local dictionary directory, or
// any file inside one, if you prefer.)
//
// Usage: node chatterbox-japanese.ts [referenceAudioSrc]
const [referenceAudioSrc] = process.argv.slice(2);

const CHATTERBOX_SAMPLE_RATE = 24000;

try {
  const modelId = await loadModel({
    modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "ja",
      s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX.src,
      mecabDictSrc: TTS_MECAB_IPADIC_CHATTERBOX.src,
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
    text: "今日はいい天気ですね。",
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`TTS complete. Total samples: ${audioBuffer.length}`);

  console.log("💾 Saving audio to file...");
  createWav(audioBuffer, CHATTERBOX_SAMPLE_RATE, "chatterbox-japanese-output.wav");
  console.log("✅ Audio saved to chatterbox-japanese-output.wav");

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
