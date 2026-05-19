import {
    loadModel,
    textToSpeech,
    unloadModel,
    type ModelProgressUpdate,
    TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
    TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32,
    TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32,
    TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32,
    TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE,
    TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE,
    TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32,
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
      modelSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32.src,
      modelType: "tts",
      modelConfig: {
        ttsEngine: "supertonic",
        language: "es",
        ttsSpeed: 1.05,
        ttsNumInferenceSteps: 5,
        ttsSupertonicMultilingual: true, //false for English quality.
        ttsTextEncoderSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32.src,
        ttsDurationPredictorSrc: TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32.src,
        ttsVectorEstimatorSrc: TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32.src,
        ttsVocoderSrc: TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32.src,
        ttsUnicodeIndexerSrc: TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32.src,
        ttsTtsConfigSrc: TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE.src,
        ttsVoiceStyleSrc: TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE.src,
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
    createWav(audioBuffer, SUPERTONIC_SAMPLE_RATE, "supertonic-multilingual-output.wav");
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

