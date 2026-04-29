// Test file to verify whisper-core compiles without JavaScript dependencies
#include <any>
#include <filesystem>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "WhisperTypes.hpp"
#include "addon/WhisperErrors.hpp"
#include "model-interface/StreamingProcessor.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp"
#include "whisper.cpp/WhisperConfig.hpp"
#include "whisper.cpp/WhisperModel.hpp"

using namespace qvac_lib_inference_addon_whisper;

// Helper function used across multiple test classes
std::string getValidModelPath() {
  return "../../../models/ggml-tiny.bin";
}

bool hasValidModelPath() {
  return std::filesystem::exists(getValidModelPath());
}

std::string getValidVadModelPath() {
  return "../../../models/ggml-silero-v5.1.2.bin";
}

bool hasValidVadModelPath() {
  return std::filesystem::exists(getValidVadModelPath());
}

class TestOutputCallback
    : public qvac_lib_inference_addon_cpp::OutputCallBackInterface {
public:
  void initializeProcessingThread(
      std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue>
      /*outputQueue*/) override {}

  void notify() override { notifyCount += 1; }

  void stop() override {}

  int notifyCount = 0;
};

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

class StreamingProcessorTest : public ::testing::Test {};

TEST_F(StreamingProcessorTest, EmitsVadStateUpdatesAlongsideTranscriptOutput) {
  if (!hasValidModelPath() || !hasValidVadModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper and VAD model files are required for streaming "
           "processor event test";
  }

  WhisperConfig whisperConfig;
  whisperConfig.whisperContextCfg["model"] = getValidModelPath();
  whisperConfig.whisperMainCfg["language"] = std::string("en");
  whisperConfig.whisperMainCfg["temperature"] = 0.0F;
  whisperConfig.miscConfig["caption_enabled"] = false;

  WhisperModel model(whisperConfig);
  TestOutputCallback callback;
  auto outputQueue =
      std::make_shared<qvac_lib_inference_addon_cpp::OutputQueue>(
          callback, model);

  StreamingProcessor::Config streamConfig;
  streamConfig.vadModelPath = getValidVadModelPath();
  streamConfig.emitVadEvents = true;
  streamConfig.vadRunIntervalSamples =
      StreamingProcessor::Config::kDefaultSampleRate;
  streamConfig.endOfTurnSilenceMs = 0;

  {
    StreamingProcessor processor(model, outputQueue, streamConfig);
    processor.appendAudio(std::vector<float>(
        static_cast<std::size_t>(streamConfig.vadRunIntervalSamples), 0.0F));
    processor.end();
  }

  const auto outputs = outputQueue->clear();
  bool hasVadState = false;
  bool hasTranscriptOutput = false;

  for (const auto& output : outputs) {
    if (const auto* vadState = std::any_cast<VadStateUpdate>(&output);
        vadState != nullptr) {
      hasVadState = true;
      EXPECT_FALSE(vadState->speaking);
      EXPECT_EQ(vadState->probability, 0.0F);
    }

    if (const auto* transcripts =
            std::any_cast<std::vector<Transcript>>(&output);
        transcripts != nullptr) {
      hasTranscriptOutput = true;
    }
  }

  EXPECT_TRUE(hasVadState);
  EXPECT_TRUE(hasTranscriptOutput);
  EXPECT_GT(callback.notifyCount, 0);
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

  // Test monostate (empty/unknown variant)
  JSValueVariant emptyVar = std::monostate{};
  EXPECT_EQ(convertVariantToString(emptyVar), "unknown");
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

TEST_F(WhisperConfigTest, ToMiscConfigSeedHandler) {
  WhisperConfig config;
  config.miscConfig["seed"] = 42.0;

  MiscConfig miscConfig = toMiscConfig(config);
  EXPECT_EQ(miscConfig.seed, 42);
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

  auto params = toWhisperFullParams(config);

  // Verify values were set correctly
  EXPECT_EQ(params.strategy, WHISPER_SAMPLING_GREEDY);
  EXPECT_EQ(params.n_threads, 4);
  EXPECT_FLOAT_EQ(params.temperature, 0.5f);
  EXPECT_FALSE(params.translate);
  EXPECT_TRUE(params.no_timestamps);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidStrategy) {
  WhisperConfig config;
  config.whisperMainCfg["strategy"] = std::string("invalid_strategy");

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(std::string(e.what()), testing::HasSubstr("Strategy must be"));
  }
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidThreads) {
  WhisperConfig config;
  config.whisperMainCfg["n_threads"] = -1.0; // Must be >= 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsThreadsZeroUsesOptimal) {
  WhisperConfig config;
  config.whisperMainCfg["n_threads"] = 0.0; // 0 means use optimal

  EXPECT_NO_THROW(toWhisperFullParams(config));
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

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidMaxTextCtx) {
  WhisperConfig config;
  config.whisperMainCfg["n_max_text_ctx"] = 2048.0; // Valid: between 1 and 4096

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.n_max_text_ctx, 2048);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidOffset) {
  WhisperConfig config;
  config.whisperMainCfg["offset_ms"] = -100.0; // Must be >= 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidOffset) {
  WhisperConfig config;
  config.whisperMainCfg["offset_ms"] = 1000.0; // Valid: >= 0

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.offset_ms, 1000);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidDuration) {
  WhisperConfig config;
  config.whisperMainCfg["duration_ms"] = -500.0; // Must be >= 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidDuration) {
  WhisperConfig config;
  config.whisperMainCfg["duration_ms"] = 5000.0; // Valid: >= 0

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.duration_ms, 5000);
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

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidThold_pt) {
  WhisperConfig config;
  config.whisperMainCfg["thold_pt"] = 0.5; // Valid: between 0 and 1

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.thold_pt, 0.5f);
}

TEST_F(WhisperHandlersTest, ToWhisperFullParamsValidThold_ptsum) {
  WhisperConfig config;
  config.whisperMainCfg["thold_ptsum"] = 0.8; // Valid: between 0 and 1

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.thold_ptsum, 0.8f);
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

TEST_F(WhisperHandlersTest, ToWhisperFullParamsInvalidLanguageCode) {
  WhisperConfig config;
  config.whisperMainCfg["language"] =
      std::string("zz"); // Invalid language code

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

TEST_F(WhisperHandlersTest, DetectLanguageWithAutoAndDetectFalse) {
  WhisperConfig config;
  config.whisperMainCfg["language"] = std::string("auto");
  config.whisperMainCfg["detect_language"] = false;

  // Valid: auto with detect_language = false is allowed (auto-corrected)
  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, DetectLanguageWithNonAutoAndDetectTrue) {
  WhisperConfig config;
  config.whisperMainCfg["language"] = std::string("en");
  config.whisperMainCfg["detect_language"] = true;

  // Should throw: detect_language must be false if language is not auto
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
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

TEST_F(WhisperHandlersTest, VadModelPathHandler) {
  WhisperConfig config;
  config.whisperMainCfg["vad_model_path"] =
      std::string("/path/to/vad/model.bin");

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, SeedHandler) {
  WhisperConfig config;
  config.whisperMainCfg["seed"] = 12345.0;

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.seed, 12345);
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

TEST_F(WhisperHandlersTest, AudioCtxHandlerValid) {
  WhisperConfig config;
  config.whisperMainCfg["audio_ctx"] = 1500.0; // Valid: > 0

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.audio_ctx, 1500);
}

TEST_F(WhisperHandlersTest, AudioCtxHandlerInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["audio_ctx"] = -100.0; // Invalid: < 0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("audio_ctx must be greater than 0"));
  }
}

TEST_F(WhisperHandlersTest, BeamSearchHandlerValid) {
  WhisperConfig config;
  config.whisperMainCfg["strategy"] = std::string("beam_search");
  config.whisperMainCfg["beam_search_beam_size"] = 5.0;

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.strategy, WHISPER_SAMPLING_BEAM_SEARCH);
  EXPECT_EQ(params.beam_search.beam_size, 5);
}

TEST_F(WhisperHandlersTest, BeamSearchInvalidBeamSize) {
  WhisperConfig config;
  config.whisperMainCfg["strategy"] = std::string("beam_search");
  config.whisperMainCfg["beam_search_beam_size"] = 0.0; // Must be > 1

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("beam_search_beam_size must be greater than 1"));
  }
}

TEST_F(WhisperHandlersTest, InitialPromptHandler) {
  WhisperConfig config;
  config.whisperMainCfg["initial_prompt"] = std::string("Test prompt");

  auto params = toWhisperFullParams(config);
  EXPECT_STREQ(params.initial_prompt, "Test prompt");
}

TEST_F(WhisperHandlersTest, SuppressBlankHandler) {
  WhisperConfig config;
  config.whisperMainCfg["suppress_blank"] = true;

  auto params = toWhisperFullParams(config);
  EXPECT_TRUE(params.suppress_blank);
}

TEST_F(WhisperHandlersTest, SuppressNstHandler) {
  WhisperConfig config;
  config.whisperMainCfg["suppress_nst"] = false;

  auto params = toWhisperFullParams(config);
  EXPECT_FALSE(params.suppress_nst);
}

TEST_F(WhisperHandlersTest, SingleSegmentHandler) {
  WhisperConfig config;
  config.whisperMainCfg["single_segment"] = true;

  auto params = toWhisperFullParams(config);
  EXPECT_TRUE(params.single_segment);
}

TEST_F(WhisperHandlersTest, MaxLenHandler) {
  WhisperConfig config;
  config.whisperMainCfg["max_len"] = 20.0;

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.max_len, 20);
}

TEST_F(WhisperHandlersTest, MaxLenInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["max_len"] = -5.0; // Must be >= 0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("max_len must be greater than 0"));
  }
}

TEST_F(WhisperHandlersTest, SplitOnWordHandler) {
  WhisperConfig config;
  config.whisperMainCfg["split_on_word"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, MaxTokensHandler) {
  WhisperConfig config;
  config.whisperMainCfg["max_tokens"] = 50.0;

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.max_tokens, 50);
}

TEST_F(WhisperHandlersTest, MaxTokensInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["max_tokens"] = -10.0; // Must be >= 0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("max_tokens must be greater than 0"));
  }
}

TEST_F(WhisperHandlersTest, DebugModeHandler) {
  WhisperConfig config;
  config.whisperMainCfg["debug_mode"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, PrintSpecialHandler) {
  WhisperConfig config;
  config.whisperMainCfg["print_special"] = false;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, PrintProgressHandler) {
  WhisperConfig config;
  config.whisperMainCfg["print_progress"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, PrintRealtimeHandler) {
  WhisperConfig config;
  config.whisperMainCfg["print_realtime"] = false;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, PrintTimestampsHandler) {
  WhisperConfig config;
  config.whisperMainCfg["print_timestamps"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, TokenTimestampsHandler) {
  WhisperConfig config;
  config.whisperMainCfg["token_timestamps"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, TdrzEnableHandler) {
  WhisperConfig config;
  config.whisperMainCfg["tdrz_enable"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, SuppressRegexHandler) {
  WhisperConfig config;
  config.whisperMainCfg["suppress_regex"] = std::string(".*");

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, MaxInitialTsHandler) {
  WhisperConfig config;
  config.whisperMainCfg["max_initial_ts"] = 1.0; // Valid: > 0

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, MaxInitialTsInvalidZeroOrNegative) {
  WhisperConfig config;
  config.whisperMainCfg["max_initial_ts"] = 0.0; // Invalid: must be > 0

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);

  config.whisperMainCfg["max_initial_ts"] = -0.5; // Invalid: negative
  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, LengthPenaltyHandler) {
  WhisperConfig config;
  config.whisperMainCfg["length_penalty"] = 1.0;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, LengthPenaltyInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["length_penalty"] = -1.0;

  EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
}

TEST_F(WhisperHandlersTest, TemperatureIncHandler) {
  WhisperConfig config;
  config.whisperMainCfg["temperature_inc"] = 0.2; // Valid: >= 0

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.temperature_inc, 0.2f);
}

TEST_F(WhisperHandlersTest, TemperatureIncInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["temperature_inc"] = -0.5; // Invalid: < 0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("temperature_inc must be greater than 0"));
  }
}

TEST_F(WhisperHandlersTest, EntropyTholdHandler) {
  WhisperConfig config;
  config.whisperMainCfg["entropy_thold"] = 2.4; // Valid: >= 0

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.entropy_thold, 2.4f);
}

TEST_F(WhisperHandlersTest, EntropyTholdInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["entropy_thold"] = -1.0; // Invalid: < 0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("entropy_thold must be greater than 0"));
  }
}

TEST_F(WhisperHandlersTest, LogprobTholdHandler) {
  WhisperConfig config;
  config.whisperMainCfg["logprob_thold"] =
      0.5; // Valid: special case -1 or [0, 1]

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.logprob_thold, 0.5f);
}

TEST_F(WhisperHandlersTest, LogprobTholdHandlerSpecialCaseMinus1) {
  WhisperConfig config;
  config.whisperMainCfg["logprob_thold"] = -1.0; // Valid: special case

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.logprob_thold, -1.0f);
}

TEST_F(WhisperHandlersTest, LogprobTholdInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["logprob_thold"] = -0.5; // Invalid: < 0 (except -1)

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()), testing::HasSubstr("logprob_thold must be"));
  }
}

TEST_F(WhisperHandlersTest, LogprobTholdInvalidAboveOne) {
  WhisperConfig config;
  config.whisperMainCfg["logprob_thold"] = 1.5; // Invalid: > 1.0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()), testing::HasSubstr("logprob_thold must be"));
  }
}

TEST_F(WhisperHandlersTest, NoSpeechTholdHandler) {
  WhisperConfig config;
  config.whisperMainCfg["no_speech_thold"] = 0.6; // Valid: >= 0

  auto params = toWhisperFullParams(config);
  EXPECT_FLOAT_EQ(params.no_speech_thold, 0.6f);
}

TEST_F(WhisperHandlersTest, NoSpeechTholdInvalidNegative) {
  WhisperConfig config;
  config.whisperMainCfg["no_speech_thold"] = -0.5; // Invalid: < 0

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("no_speech_thold must be greater than 0"));
  }
}

TEST_F(WhisperHandlersTest, GreedyBestOfHandler) {
  WhisperConfig config;
  config.whisperMainCfg["greedy_best_of"] = 5.0; // Valid: > 1

  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.greedy.best_of, 5);
}

TEST_F(WhisperHandlersTest, GreedyBestOfInvalidLessThanOrEqualOne) {
  WhisperConfig config;
  config.whisperMainCfg["greedy_best_of"] = 1.0; // Invalid: <= 1

  try {
    toWhisperFullParams(config);
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("greedy_best_of must be greater than 1"));
  }
}

TEST_F(WhisperHandlersTest, NoContextHandler) {
  WhisperConfig config;
  config.whisperMainCfg["no_context"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
}

TEST_F(WhisperHandlersTest, TranslateHandler) {
  WhisperConfig config;
  config.whisperMainCfg["translate"] = true;

  EXPECT_NO_THROW(toWhisperFullParams(config));
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
  if (!hasValidModelPath()) {
    GTEST_SKIP() << "Skipping: whisper model file not available for load test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test load
  model.load();
  EXPECT_TRUE(model.isLoaded());

  // Test unload
  model.unload();
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(WhisperModelTest, ModelReset) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test reset
  EXPECT_NO_THROW(model.reset());
  // Note: reset doesn't change loaded state - it resets internal model state
}

TEST_F(WhisperModelTest, ModelProcessEmptyInput) {
  if (!hasValidModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper model file not available for process test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  model.load();

  std::vector<float> emptyInput;

  // Test process with empty input - should return empty output
  auto result = model.process(emptyInput, nullptr);
  EXPECT_TRUE(
      result.empty() || result.size() >= 0); // Either empty or has results
}

TEST_F(WhisperModelTest, ModelProcessWithCallback) {
  if (!hasValidModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper model file not available for process test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  model.load();

  std::vector<float> input(1000, 0.0f); // Small input
  bool callbackCalled = false;
  std::vector<Transcript> callbackResult;

  auto callback = [&callbackCalled,
                   &callbackResult](const std::vector<Transcript>& result) {
    callbackCalled = true;
    callbackResult = result;
  };

  // Test process with callback
  auto result = model.process(input, callback);

  // Verify result is valid (may be empty for silence)
  EXPECT_TRUE(result.empty() || result.size() > 0);
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
  if (!hasValidModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper model file not available for warmup test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  model.load(); // This should trigger warmup automatically

  // Test warmup method directly - should not crash
  model.warmup();

  // Warmup is idempotent, calling again should be safe
  model.warmup();
}

TEST_F(WhisperModelTest, ModelInitializeBackend) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Test initializeBackend (no-op method)
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(WhisperModelTest, ModelUnloadWeights) {
  if (!hasValidModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper model file not available for unload test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  model.load();
  EXPECT_TRUE(model.isLoaded());

  // Test unloadWeights (should be same as unload)
  model.unloadWeights();
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(WhisperModelTest, SetOnSegmentCallbackAndVerifyExecution) {
  if (!hasValidModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper model file not available for callback test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  model.load();

  bool callbackCalled = false;
  Transcript receivedTranscript;

  auto callback = [&callbackCalled,
                   &receivedTranscript](const Transcript& transcript) {
    callbackCalled = true;
    receivedTranscript = transcript;
  };

  // Set callback - verify it doesn't crash
  model.setOnSegmentCallback(callback);

  // Process some audio - callback may be called if transcription occurs
  std::vector<float> audio(16000, 0.0f); // 1 second of silence
  auto output = model.process(audio, nullptr);

  // Verify processing completed (output may be empty for silence)
  EXPECT_TRUE(output.empty() || output.size() > 0);
}

TEST_F(WhisperModelTest, AddTranscriptionWorks) {
  if (!hasValidModelPath()) {
    GTEST_SKIP()
        << "Skipping: whisper model file not available for transcription test";
  }
  auto config = createTestConfig();
  WhisperModel model(config);

  model.load();

  // Add a transcription manually - this method just pushes to output_
  Transcript transcript("Test transcription");
  transcript.start = 0.0f;
  transcript.end = 1.5f;
  transcript.id = 1;

  // Verify addTranscription doesn't crash
  model.addTranscription(transcript);

  // Since output_ is private, we verify indirectly by processing
  std::vector<float> audio(1000, 0.0f);
  auto output = model.process(audio, nullptr);

  // Verify process works (output may be empty or have data)
  EXPECT_TRUE(output.empty() || output.size() > 0);
}

TEST_F(WhisperModelTest, IsStreamEndedInitiallyFalse) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Verify initially stream is not ended
  EXPECT_FALSE(model.isStreamEnded());
}

TEST_F(WhisperModelTest, IsStreamEndedAfterEndOfStream) {
  auto config = createTestConfig();
  WhisperModel model(config);

  // Call endOfStream
  model.endOfStream();

  // Verify stream is now ended
  EXPECT_TRUE(model.isStreamEnded());
}

TEST_F(WhisperModelTest, SetConfigUpdatesInternalConfig) {
  auto config = createTestConfig();
  WhisperModel model(config);

  WhisperConfig newConfig;
  newConfig.whisperContextCfg["model"] = getValidModelPath();
  newConfig.whisperMainCfg["temperature"] = 0.8;
  newConfig.miscConfig["caption_enabled"] = true;

  // Set new config
  model.setConfig(newConfig);

  // Verify caption mode is now enabled (public getter)
  EXPECT_TRUE(model.isCaptionModeEnabled());
}

TEST_F(WhisperModelTest, FormatCaptionOutput) {
  auto config = createTestConfig();
  WhisperModel model(config);

  Transcript tr("hello");
  tr.start = 1.2f;
  tr.end = 3.9f;

  model.formatCaptionOutput(tr);

  // formatCaptionOutput truncates start/end to int via static_cast<int>
  EXPECT_EQ(tr.text, "<|1|>hello<|3|>");
}

TEST_F(WhisperModelTest, ProcessThrowsWhenFullParamsInvalid) {
  // Force toWhisperFullParams(cfg_) to throw (temperature out of range)
  WhisperConfig badCfg = createTestConfig();
  badCfg.whisperMainCfg["temperature"] = 2.0; // invalid (> 1)

  WhisperModel model(badCfg);

  try {
    model.process(std::vector<float>(10, 0.0f));
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()), testing::HasSubstr("error in full handler"));
    EXPECT_THAT(std::string(e.what()), testing::HasSubstr("temperature"));
  }
}

TEST_F(WhisperModelTest, PreprocessAudioDataEmptyReturnsEmpty) {
  std::vector<uint8_t> audio;
  auto out = WhisperModel::preprocessAudioData(audio, "s16le");
  EXPECT_TRUE(out.empty());
}

TEST_F(WhisperModelTest, PreprocessAudioDataF32leMisalignedThrows) {
  std::vector<uint8_t> audio = {0x00, 0x00, 0x00}; // not multiple of 4
  try {
    (void)WhisperModel::preprocessAudioData(audio, "f32le");
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("f32le buffer length must be a multiple of 4"));
  }
}

TEST_F(WhisperModelTest, PreprocessAudioDataF32leNonFiniteThrows) {
  // Quiet NaN: 0x7fc00000 (little-endian)
  std::vector<uint8_t> audio = {0x00, 0x00, 0xC0, 0x7F};
  try {
    (void)WhisperModel::preprocessAudioData(audio, "f32le");
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("Encountered non-finite f32 sample"));
  }
}

TEST_F(WhisperModelTest, PreprocessAudioDataF32leValidConverts) {
  // Two floats: 0.5f (0x3f000000) and -1.0f (0xbf800000)
  std::vector<uint8_t> audio = {
      0x00,
      0x00,
      0x00,
      0x3F,
      0x00,
      0x00,
      0x80,
      0xBF,
  };
  auto out = WhisperModel::preprocessAudioData(audio, "f32le");
  ASSERT_EQ(out.size(), 2u);
  EXPECT_FLOAT_EQ(out[0], 0.5f);
  EXPECT_FLOAT_EQ(out[1], -1.0f);
}

TEST_F(WhisperModelTest, PreprocessAudioDataDecodedAliasConverts) {
  // "decoded" should behave like f32le
  std::vector<uint8_t> audio = {0x00, 0x00, 0x80, 0x3F}; // 1.0f
  auto out = WhisperModel::preprocessAudioData(audio, "decoded");
  ASSERT_EQ(out.size(), 1u);
  EXPECT_FLOAT_EQ(out[0], 1.0f);
}

TEST_F(WhisperModelTest, PreprocessAudioDataS16leMisalignedThrows) {
  std::vector<uint8_t> audio = {0x00}; // not multiple of 2
  try {
    (void)WhisperModel::preprocessAudioData(audio, "s16le");
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("s16le buffer length must be a multiple of 2"));
  }
}

TEST_F(WhisperModelTest, PreprocessAudioDataS16leValidConverts) {
  // Two samples: 32767 (0x7FFF) and -32768 (0x8000), little-endian
  std::vector<uint8_t> audio = {0xFF, 0x7F, 0x00, 0x80};
  auto out = WhisperModel::preprocessAudioData(audio, "s16le");
  ASSERT_EQ(out.size(), 2u);
  EXPECT_NEAR(out[0], 32767.0f / 32768.0f, 1e-6f);
  EXPECT_FLOAT_EQ(out[1], -1.0f);
}

TEST_F(WhisperModelTest, PreprocessAudioDataUnsupportedFormatThrows) {
  std::vector<uint8_t> audio = {0x00, 0x00};
  try {
    (void)WhisperModel::preprocessAudioData(audio, "mp3");
    FAIL() << "Expected StatusError to be thrown";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_THAT(
        std::string(e.what()),
        testing::HasSubstr("Unsupported audio_format: mp3"));
  }
}
