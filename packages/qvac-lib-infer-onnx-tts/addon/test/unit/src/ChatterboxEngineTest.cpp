#include "src/model-interface/ChatterboxEngine.hpp"
#include <gtest/gtest.h>
#include <stdexcept>

namespace qvac::ttslib::chatterbox::testing {

class ChatterboxEngineTest : public ::testing::Test {
public:
  // Dummy paths for validation testing (files don't need to exist for
  // validation tests)
  const std::string dummyPath_ = "dummy_path";

  // Reference audio (required for Chatterbox)
  std::vector<float> referenceAudio_ = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};

  ChatterboxConfig validConfig_{
      "en",            // language
      referenceAudio_, // referenceAudio
      dummyPath_,      // tokenizerPath
      dummyPath_,      // speechEncoderPath
      dummyPath_,      // embedTokensPath
      dummyPath_,      // conditionalDecoderPath
      dummyPath_       // languageModelPath
  };

  ChatterboxConfig emptyConfig_{};

  ChatterboxConfig unsupportedLanguageConfig_{
      "unsupported_lang", // language (unsupported)
      referenceAudio_,    dummyPath_, dummyPath_,
      dummyPath_,         dummyPath_, dummyPath_};

  ChatterboxConfig missingTokenizerConfig_{
      "en",
      referenceAudio_,
      "nonexistent_tokenizer.json", // tokenizerPath (doesn't exist)
      dummyPath_,
      dummyPath_,
      dummyPath_,
      dummyPath_};

  ChatterboxConfig missingSpeechEncoderConfig_{
      "en",
      referenceAudio_,
      dummyPath_,
      "nonexistent_speech_encoder.onnx", // speechEncoderPath (doesn't exist)
      dummyPath_,
      dummyPath_,
      dummyPath_};

  ChatterboxConfig missingEmbedTokensConfig_{
      "en",
      referenceAudio_,
      dummyPath_,
      dummyPath_,
      "nonexistent_embed_tokens.onnx", // embedTokensPath (doesn't exist)
      dummyPath_,
      dummyPath_};

  ChatterboxConfig missingConditionalDecoderConfig_{
      "en", referenceAudio_, dummyPath_, dummyPath_, dummyPath_,
      "nonexistent_conditional_decoder.onnx", // conditionalDecoderPath (doesn't
                                              // exist)
      dummyPath_};

  ChatterboxConfig missingLanguageModelConfig_{
      "en",
      referenceAudio_,
      dummyPath_,
      dummyPath_,
      dummyPath_,
      dummyPath_,
      "nonexistent_language_model.onnx" // languageModelPath (doesn't exist)
  };

  ChatterboxConfig emptyReferenceAudioConfig_{
      "en",       {}, // empty referenceAudio
      dummyPath_, dummyPath_, dummyPath_, dummyPath_, dummyPath_};
};

// Note: These tests verify that ChatterboxEngine throws appropriate errors
// for invalid configurations. The actual file validation happens in load().

TEST_F(ChatterboxEngineTest, negativeEmptyConfig) {
  // Empty config should fail due to missing required fields
  EXPECT_THROW(ChatterboxEngine engine(emptyConfig_), std::exception);
}

TEST_F(ChatterboxEngineTest, negativeMissingTokenizer) {
  // Missing tokenizer file should throw
  EXPECT_THROW(ChatterboxEngine engine(missingTokenizerConfig_),
               std::exception);
}

TEST_F(ChatterboxEngineTest, negativeMissingSpeechEncoder) {
  // Missing speech encoder file should throw
  EXPECT_THROW(ChatterboxEngine engine(missingSpeechEncoderConfig_),
               std::exception);
}

TEST_F(ChatterboxEngineTest, negativeMissingEmbedTokens) {
  // Missing embed tokens file should throw
  EXPECT_THROW(ChatterboxEngine engine(missingEmbedTokensConfig_),
               std::exception);
}

TEST_F(ChatterboxEngineTest, negativeMissingConditionalDecoder) {
  // Missing conditional decoder file should throw
  EXPECT_THROW(ChatterboxEngine engine(missingConditionalDecoderConfig_),
               std::exception);
}

TEST_F(ChatterboxEngineTest, negativeMissingLanguageModel) {
  // Missing language model file should throw
  EXPECT_THROW(ChatterboxEngine engine(missingLanguageModelConfig_),
               std::exception);
}

// Note: Integration tests that require actual model files are skipped
// unless the model files are available. The mock-based tests in
// TTSModelChatterboxTestMock.cpp provide coverage for TTSModel integration.

} // namespace qvac::ttslib::chatterbox::testing
