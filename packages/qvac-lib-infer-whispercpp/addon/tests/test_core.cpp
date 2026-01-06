// Test file to verify whisper-core compiles without JavaScript dependencies
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "WhisperTypes.hpp"
#include "addon/WhisperErrors.hpp"
#include "qvac-lib-inference-addon-cpp/ModelApiTest.hpp"
#include "whisper.cpp/WhisperConfig.hpp"
#include "whisper.cpp/WhisperModel.hpp"

using namespace qvac_lib_inference_addon_whisper;

// Helper function used across multiple test classes
std::string getValidModelPath() {
  // Check for model in test directory first
  std::string testPath = "../../../models/ggml-tiny.bin";
  if (std::filesystem::exists(testPath)) {
    return testPath;
  }
  // Fallback to models directory
  std::string modelPath = "../models/ggml-tiny.bin";
  if (std::filesystem::exists(modelPath)) {
    return modelPath;
  }
  // Return test path even if it doesn't exist (test will skip)
  return testPath;
}

class WhisperCoreSimpleTest : public ::testing::Test {};

TEST_F(WhisperCoreSimpleTest, WhisperConfigTest) {
  std::cout << "Testing whisper-core compilation..." << std::endl;

  // Test creating a WhisperConfig without JavaScript
  qvac_lib_inference_addon_whisper::WhisperConfig config;

  // Test setting parameters directly
  config.whisperMainCfg["model"] = std::string("test-model.bin");
  config.whisperMainCfg["language"] = std::string("en");
  config.whisperMainCfg["temperature"] = 0.8;

  // Test getting parameters
  auto it = config.whisperMainCfg.find("model");
  if (it != config.whisperMainCfg.end()) {
    if (const auto* modelPath = std::get_if<std::string>(&it->second)) {
      EXPECT_EQ(*modelPath, "test-model.bin");
    }
  }

  EXPECT_TRUE(true);
}

// ============================================================================
// WhisperErrors Tests - Testing error handling and error codes
// ============================================================================

class WhisperErrorsTest : public ::testing::Test {};

TEST_F(WhisperErrorsTest, ErrorCodeToString) {
  using namespace qvac_lib_inference_addon_whisper::errors;

  // Test all error codes
  EXPECT_EQ(
      toString(UnableToCreateWhisperContext), "UnableToCreateWhisperContext");
  EXPECT_EQ(toString(UnableToTranscribe), "UnableToTranscribe");
  EXPECT_EQ(toString(UnableToCreateVadContext), "UnableToCreateVadContext");
  EXPECT_EQ(toString(UnableToDetectVADSegments), "UnableToDetectVADSegments");
  EXPECT_EQ(toString(MisalignedBuffer), "MisalignedBuffer");
  EXPECT_EQ(toString(NonFiniteSample), "NonFiniteSample");
  EXPECT_EQ(toString(UnsupportedAudioFormat), "UnsupportedAudioFormat");

  // Test invalid error code (should return "UnknownError")
  WhisperErrorCode invalidCode = static_cast<WhisperErrorCode>(255);
  EXPECT_EQ(toString(invalidCode), "UnknownError");
}

TEST_F(WhisperErrorsTest, QvacErrorsWhisperStatus) {
  using namespace qvac_errors::whisper_error;

  // Test creating status errors
  auto status1 = makeStatus(Code::MisalignedBuffer, "Buffer alignment issue");
  EXPECT_EQ(status1.codeString(), "[ Whisper :: WhisperError ]");
  EXPECT_EQ(std::string(status1.what()), "Buffer alignment issue");

  auto status2 = makeStatus(Code::NonFiniteSample, "Invalid audio sample");
  EXPECT_EQ(status2.codeString(), "[ Whisper :: WhisperError ]");
  EXPECT_EQ(std::string(status2.what()), "Invalid audio sample");

  auto status3 = makeStatus(Code::UnsupportedAudioFormat, "Unsupported format");
  EXPECT_EQ(status3.codeString(), "[ Whisper :: WhisperError ]");
  EXPECT_EQ(std::string(status3.what()), "Unsupported format");
  EXPECT_FALSE(status3.isJSError());
}

// ============================================================================
// WhisperTypes Tests - Testing data structures and types
// ============================================================================

class WhisperTypesTest : public ::testing::Test {};

TEST_F(WhisperTypesTest, TranscriptDefaultConstructor) {
  Transcript transcript;

  EXPECT_EQ(transcript.text, "");
  EXPECT_FALSE(transcript.toAppend);
  EXPECT_EQ(transcript.start, -1.0f);
  EXPECT_EQ(transcript.end, -1.0f);
  EXPECT_EQ(transcript.id, 0);
}

TEST_F(WhisperTypesTest, TranscriptStringConstructor) {
  Transcript transcript("Hello world");

  EXPECT_EQ(transcript.text, "Hello world");
  EXPECT_FALSE(transcript.toAppend);
  EXPECT_EQ(transcript.start, -1.0f);
  EXPECT_EQ(transcript.end, -1.0f);
  EXPECT_EQ(transcript.id, 0);
}

TEST_F(WhisperTypesTest, TranscriptModification) {
  Transcript transcript;

  // Test modifying all fields
  transcript.text = "Modified text";
  transcript.toAppend = true;
  transcript.start = 1.5f;
  transcript.end = 3.2f;
  transcript.id = 42;

  EXPECT_EQ(transcript.text, "Modified text");
  EXPECT_TRUE(transcript.toAppend);
  EXPECT_EQ(transcript.start, 1.5f);
  EXPECT_EQ(transcript.end, 3.2f);
  EXPECT_EQ(transcript.id, 42);
}

TEST_F(WhisperTypesTest, TranscriptionProfile) {
  // Test enum values
  TranscriptionProfile defaultProfile = TranscriptionProfile::Default;
  TranscriptionProfile vadProfile = TranscriptionProfile::Vad;

  EXPECT_EQ(static_cast<std::uint8_t>(defaultProfile), 0);
  EXPECT_EQ(static_cast<std::uint8_t>(vadProfile), 1);

  // Test enum comparison
  EXPECT_NE(defaultProfile, vadProfile);
}

// ============================================================================
// WhisperConfig Tests - Testing configuration conversion and validation
// ============================================================================

class WhisperConfigTest : public ::testing::Test {};

TEST_F(WhisperConfigTest, ConvertVariantToString) {
  // Test string variant
  JSValueVariant stringVar = std::string("test_string");
  EXPECT_EQ(convertVariantToString(stringVar), "test_string");

  // Test int variant
  JSValueVariant intVar = 42;
  EXPECT_EQ(convertVariantToString(intVar), "42");

  // Test double variant
  JSValueVariant doubleVar = 3.14;
  EXPECT_EQ(convertVariantToString(doubleVar), "3.140000");

  // Test bool variants
  JSValueVariant boolTrueVar = true;
  JSValueVariant boolFalseVar = false;
  EXPECT_EQ(convertVariantToString(boolTrueVar), "1");
  EXPECT_EQ(convertVariantToString(boolFalseVar), "0");
}

TEST_F(WhisperConfigTest, DefaultMiscConfig) {
  MiscConfig defaultConfig = defaultMiscConfig();
  EXPECT_FALSE(defaultConfig.captionModeEnabled);
}

TEST_F(WhisperConfigTest, ToMiscConfigValid) {
  WhisperConfig config;
  config.miscConfig["caption_enabled"] = true;

  MiscConfig miscConfig = toMiscConfig(config);
  EXPECT_TRUE(miscConfig.captionModeEnabled);
}

TEST_F(WhisperConfigTest, ToMiscConfigInvalidHandler) {
  WhisperConfig config;
  config.miscConfig["invalid_key"] = true;

  // Should throw exception for invalid handler key
  EXPECT_THROW(toMiscConfig(config), qvac_errors::StatusError);
}

// ============================================================================
// WhisperHandlers Tests - Testing parameter validation and edge cases
// ============================================================================

class WhisperHandlersTest : public ::testing::Test {};

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidConfig) {
  WhisperConfig config;

  // Test with valid parameters
  config.whisperMainCfg["strategy"] = std::string("greedy");
  config.whisperMainCfg["n_threads"] = 4.0;
  config.whisperMainCfg["temperature"] = 0.5;
  config.whisperMainCfg["translate"] = false;
  config.whisperMainCfg["no_timestamps"] = true;

  // Should not throw
  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidStrategy) {
  WhisperConfig config;
  config.whisperMainCfg["strategy"] = std::string("invalid_strategy");

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidThreads) {
  WhisperConfig config;
  config.whisperMainCfg["n_threads"] = 0.0; // Must be > 1

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidTemperature) {
  WhisperConfig config;
  config.whisperMainCfg["temperature"] = 1.5; // Must be between 0 and 1

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidMaxTextCtx) {
  WhisperConfig config;

  // Test too low
  config.whisperMainCfg["n_max_text_ctx"] = 0.0;
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);

  // Test too high
  config.whisperMainCfg["n_max_text_ctx"] = 5000.0;
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidOffset) {
  WhisperConfig config;
  config.whisperMainCfg["offset_ms"] = -100.0; // Must be >= 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidDuration) {
  WhisperConfig config;
  config.whisperMainCfg["duration_ms"] = -500.0; // Must be >= 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidThresholds) {
  WhisperConfig config;

  // Invalid thold_pt
  config.whisperMainCfg["thold_pt"] = 1.5; // Must be between 0 and 1
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);

  config.whisperMainCfg.clear();

  // Invalid thold_ptsum
  config.whisperMainCfg["thold_ptsum"] = -0.5; // Must be between 0 and 1
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidLanguage) {
  WhisperConfig config;

  // Test empty language
  config.whisperMainCfg["language"] = std::string("");
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);

  config.whisperMainCfg.clear();

  // Test invalid length language
  config.whisperMainCfg["language"] =
      std::string("eng"); // Must be 2 chars or "auto"
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidDetectLanguage) {
  WhisperConfig config;

  // Test valid detect_language and language settings
  config.whisperMainCfg["language"] = std::string("auto");
  // Don't set detect_language - it should be set automatically by language
  // handler

  // Should not throw
  EXPECT_NO_THROW(toWhisperFullParams(config));

  // Test another valid combination - specific language without detect_language
  config.whisperMainCfg.clear();
  config.whisperMainCfg["language"] = std::string("en");
  // Don't set detect_language - it should be set automatically by language
  // handler

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, ToWhisperContextParamsValid) {
  WhisperConfig config;
  config.whisperContextCfg["use_gpu"] = true;
  config.whisperContextCfg["flash_attn"] = false;
  config.whisperContextCfg["gpu_device"] = 0.0;

  // Should not throw
  EXPECT_NO_THROW(toWhisperContextParams(config));
}

TEST_F(WhisperHandlersTest, ToWhisperContextParamsInvalidHandler) {
  WhisperConfig config;
  config.whisperContextCfg["invalid_key"] = true;

  EXPECT_THROW(toWhisperContextParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, VadHandlersValidation) {
  WhisperConfig config;

  // Test valid VAD parameters
  config.vadCfg["threshold"] = 0.5;
  config.vadCfg["min_speech_duration_ms"] = 250.0;
  config.vadCfg["min_silence_duration_ms"] = 100.0;
  config.vadCfg["max_speech_duration_s"] = 30.0;
  config.vadCfg["speech_pad_ms"] = 50.0;
  config.vadCfg["samples_overlap"] = 0.25;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, VadHandlersInvalidMaxSpeechDuration) {
  WhisperConfig config;
  config.vadCfg["max_speech_duration_s"] = -1.0; // Must be > 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, VadHandlersInvalidSamplesOverlap) {
  WhisperConfig config;
  config.vadCfg["samples_overlap"] = 1.5; // Must be between 0 and 1

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

// ============================================================================
// WhisperModel Tests - Testing model functionality
// ============================================================================

class WhisperModelTest : public ::testing::Test {
protected:
  WhisperConfig createTestConfig() {
    WhisperConfig config;
    config.whisperContextCfg["model"] = getValidModelPath();
    config.whisperMainCfg["temperature"] = 0.5;
    config.miscConfig["caption_enabled"] = false;
    return config;
  }
};

TEST_F(WhisperModelTest, ModelConstruction) {
  auto config = createTestConfig();

  // Test construction with WhisperConfig
  EXPECT_NO_THROW(WhisperModel model(config));
}

TEST_F(WhisperModelTest, ModelLoadAndUnload) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test load - may fail if model file doesn't exist, but shouldn't crash
  if (std::filesystem::exists(getValidModelPath())) {
    EXPECT_NO_THROW(model.load());
    EXPECT_TRUE(model.isLoaded());

    // Test unload
    EXPECT_NO_THROW(model.unload());
    EXPECT_FALSE(model.isLoaded());
  } else {
    // Skip if model file doesn't exist
    GTEST_SKIP() << "Model file not found, skipping load test";
  }
}

TEST_F(WhisperModelTest, ModelReset) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test reset
  EXPECT_NO_THROW(model.reset());
  // Note: reset doesn't change loaded state - it resets internal model state
}

TEST_F(WhisperModelTest, ModelProcessEmptyInput) {
  auto config = createTestConfig();
  WhisperModel model(config);

  if (std::filesystem::exists(getValidModelPath())) {
    model.load();

    std::vector<float> emptyInput;

    // Test process with empty input - should not crash
    EXPECT_NO_THROW(auto result = model.process(emptyInput, nullptr));
  } else {
    GTEST_SKIP() << "Model file not found, skipping process test";
  }
}

TEST_F(WhisperModelTest, ModelProcessWithCallback) {
  auto config = createTestConfig();
  WhisperModel model(config);

  if (std::filesystem::exists(getValidModelPath())) {
    model.load();

    std::vector<float> input(1000, 0.0f); // Small input
    bool callbackCalled = false;

    auto callback = [&callbackCalled](const std::vector<Transcript>& result) {
      callbackCalled = true;
    };

    // Test process with callback
    EXPECT_NO_THROW(auto result = model.process(input, callback));

    // Note: callback may not be called if no transcription is produced
  } else {
    GTEST_SKIP() << "Model file not found, skipping callback test";
  }
}

TEST_F(WhisperModelTest, ModelSetWeightsForFile) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test set_weights_for_file with filename and span
  std::vector<uint8_t> weights = {1, 2, 3, 4};
  std::span<const uint8_t> weightSpan(weights);

  // This method should handle the input gracefully even if not fully
  // implemented
  EXPECT_NO_THROW(
      model.set_weights_for_file("test_weights.bin", weightSpan, true));
}

TEST_F(WhisperModelTest, ModelInputViewType) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test that InputView type alias works
  std::vector<float> input = {1.0f, 2.0f, 3.0f};
  WhisperModel::InputView view(input);

  EXPECT_EQ(view.size(), 3);
  EXPECT_EQ(view[0], 1.0f);
  EXPECT_EQ(view[1], 2.0f);
  EXPECT_EQ(view[2], 3.0f);
}

TEST_F(WhisperModelTest, ModelWarmup) {
  auto config = createTestConfig();
  WhisperModel model(config);

  if (std::filesystem::exists(getValidModelPath())) {
    model.load(); // This should trigger warmup automatically

    // Test warmup method directly
    EXPECT_NO_THROW(model.warmup());
  } else {
    // Test warmup without context (should warn but not crash)
    EXPECT_NO_THROW(model.warmup());
    GTEST_SKIP() << "Model file not found, skipping warmup with context test";
  }
}

TEST_F(WhisperModelTest, ModelInitializeBackend) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test initializeBackend (no-op method)
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(WhisperModelTest, ModelUnloadWeights) {
  auto config = createTestConfig();
  WhisperModel model(config);

  if (std::filesystem::exists(getValidModelPath())) {
    model.load();
    EXPECT_TRUE(model.isLoaded());

    // Test unloadWeights (should be same as unload)
    EXPECT_NO_THROW(model.unloadWeights());
    EXPECT_FALSE(model.isLoaded());
  } else {
    GTEST_SKIP() << "Model file not found, skipping unload weights test";
  }
}

// ============================================================================
// Model API Tests (using vcpkg framework with Shared Adapter Pattern)
// ============================================================================

using TestModel = WhisperModel;

WhisperConfig createValidConfig() {
  WhisperConfig config;
  // Model path goes in whisperContextCfg (used by load())
  config.whisperContextCfg["model"] = getValidModelPath();
  // Other whisper parameters go in whisperMainCfg (use correct handler names
  // and types)
  config.whisperMainCfg["beam_search_beam_size"] =
      2.0; // Must be > 1, handler expects double
  config.whisperMainCfg["temperature"] = 0.5; // Between 0 and 1
  // Caption mode flag required by isCaptionModeEnabled()
  config.miscConfig["caption_enabled"] = false;
  return config;
}

WhisperConfig createInvalidConfig() {
  WhisperConfig config;
  // Invalid model path in whisperContextCfg
  config.whisperContextCfg["model"] = std::string("invalid/path/model.bin");
  // Still need the caption flag
  config.miscConfig["caption_enabled"] = false;
  return config;
}

// Factory functions required by ModelApiTest.hpp
TestModel make_valid_model() { return WhisperModel(createValidConfig()); }

TestModel make_invalid_model() { return WhisperModel(createInvalidConfig()); }

std::vector<float> make_valid_input() {
  // 1 second of silence at 16kHz
  return std::vector<float>(16000, 0.0f);
}

std::vector<float> make_empty_input() { return std::vector<float>(); }

// Instantiate the enhanced model API tests using adapter
MODEL_API_INSTANTIATE_TESTS(TestModel)
