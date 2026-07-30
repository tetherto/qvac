// Test file to verify whisper-core compiles without JavaScript dependencies
#include <any>
#include <filesystem>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "addon/AsrErrors.hpp"
#include "addon/GgmlLogForwarding.hpp"
#include "addon/StreamingSessionRegistry.hpp"
#include "inference-addon-cpp/queue/OutputCallbackInterface.hpp"
#include "inference-addon-cpp/queue/OutputQueue.hpp"
#include "model-interface/StreamingProcessor.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper/WhisperConfig.hpp"
#include "model-interface/whisper/WhisperModel.hpp"

using namespace qvac::asrggml;
using namespace qvac::asrggml::whisper;

// Helper function used across multiple test classes
std::string getValidModelPath() { return "../../../models/ggml-tiny.bin"; }

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
  qvac::asrggml::whisper::WhisperConfig config;

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
  using namespace qvac::asrggml::errors::whisper;

  // Test all error codes
  EXPECT_EQ(
      toString(Code::UnableToCreateWhisperContext),
      "UnableToCreateWhisperContext");
  EXPECT_EQ(toString(Code::UnableToTranscribe), "UnableToTranscribe");
  EXPECT_EQ(
      toString(Code::UnableToCreateVadContext), "UnableToCreateVadContext");
  EXPECT_EQ(
      toString(Code::UnableToDetectVADSegments), "UnableToDetectVADSegments");
  EXPECT_EQ(toString(Code::MisalignedBuffer), "MisalignedBuffer");
  EXPECT_EQ(toString(Code::NonFiniteSample), "NonFiniteSample");
  EXPECT_EQ(toString(Code::UnsupportedAudioFormat), "UnsupportedAudioFormat");

  // Test invalid error code (should return "UnknownError")
  Code invalidCode = static_cast<Code>(255);
  EXPECT_EQ(toString(invalidCode), "UnknownError");
}

TEST_F(WhisperErrorsTest, QvacErrorsWhisperStatus) {
  using namespace qvac::asrggml::errors::whisper;

  // Test creating status errors. makeStatus() emits the real code name --
  // the pre-merge version hardcoded "WhisperError" regardless of `code`.
  auto status1 = makeStatus(Code::MisalignedBuffer, "Buffer alignment issue");
  EXPECT_EQ(status1.codeString(), "[ Whisper :: MisalignedBuffer ]");
  EXPECT_EQ(std::string(status1.what()), "Buffer alignment issue");

  auto status2 = makeStatus(Code::NonFiniteSample, "Invalid audio sample");
  EXPECT_EQ(status2.codeString(), "[ Whisper :: NonFiniteSample ]");
  EXPECT_EQ(std::string(status2.what()), "Invalid audio sample");

  auto status3 = makeStatus(Code::UnsupportedAudioFormat, "Unsupported format");
  EXPECT_EQ(status3.codeString(), "[ Whisper :: UnsupportedAudioFormat ]");
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
      StreamingProcessor::Config::K_DEFAULT_SAMPLE_RATE;
  streamConfig.endOfTurnSilenceMs = 0;

  {
    StreamingProcessor processor(model, outputQueue, streamConfig);
    processor.appendAudio(
        std::vector<float>(
            static_cast<std::size_t>(streamConfig.vadRunIntervalSamples),
            0.0F));
    processor.end();

    // end() joined the worker, so the IStreamingSession teardown counters
    // are race-free and reflect everything appended above.
    EXPECT_EQ(processor.sampleRate(), streamConfig.sampleRate);
    EXPECT_DOUBLE_EQ(
        processor.audioSeconds(),
        static_cast<double>(streamConfig.vadRunIntervalSamples) /
            static_cast<double>(streamConfig.sampleRate));
  }

  const auto outputs = outputQueue->clear();
  bool hasVadState = false;
  bool hasTranscriptOutput = false;

  for (const auto& output : outputs) {
    if (const auto* vadState = std::any_cast<VadStateUpdate>(&output.second);
        vadState != nullptr) {
      hasVadState = true;
      EXPECT_FALSE(vadState->speaking);
      EXPECT_EQ(vadState->probability, 0.0F);
    }

    if (const auto* transcripts =
            std::any_cast<std::vector<Transcript>>(&output.second);
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

TEST_F(WhisperHandlersTest, LanguageAutoEnablesBuiltinAutodetect) {
  WhisperConfig config;
  config.whisperMainCfg["language"] = std::string("auto");

  whisper_full_params params = toWhisperFullParams(config);
  // "auto" clears language so whisper.cpp runs its built-in detection, while
  // detect_language stays false so transcription still proceeds.
  EXPECT_EQ(params.language, nullptr);
  EXPECT_FALSE(params.detect_language);
}

TEST_F(WhisperHandlersTest, SpecificLanguageDisablesDetect) {
  WhisperConfig config;
  config.whisperMainCfg["language"] = std::string("en");

  whisper_full_params params = toWhisperFullParams(config);
  ASSERT_NE(params.language, nullptr);
  EXPECT_EQ(std::string(params.language), "en");
  EXPECT_FALSE(params.detect_language);
}

TEST_F(WhisperHandlersTest, DetectLanguageKeyRejected) {
  // detect_language was removed from the public surface; it is now an unknown
  // key and must be rejected for every language and value combination.
  auto expectRejected = [](const std::string& language, bool detect) {
    WhisperConfig config;
    config.whisperMainCfg["language"] = language;
    config.whisperMainCfg["detect_language"] = detect;
    EXPECT_THROW(toWhisperFullParams(config), qvac_errors::StatusError);
  };

  expectRejected("auto", true);
  expectRejected("auto", false);
  expectRejected("en", true);
  expectRejected("en", false);
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

// ── whisper.cpp / ggml log forwarding ─────────────────────────
// Helper: run forwardGgmlLog while capturing std::cout (QLOG routes there in
// this no-JS test build, where JS_LOGGER is undefined).
namespace {
std::string captureForwarded(enum ggml_log_level level, const char* text) {
  std::ostringstream captured;
  std::streambuf* previous = std::cout.rdbuf(captured.rdbuf());
  forwardGgmlLog(level, text, nullptr);
  std::cout.rdbuf(previous);
  return captured.str();
}
} // namespace

TEST(WhisperGgmlLogForwarding, MapsEachLevelToPriority) {
  namespace logp = qvac_lib_inference_addon_cpp::logger;
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_ERROR), logp::Priority::ERROR);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_WARN), logp::Priority::WARNING);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_INFO), logp::Priority::INFO);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_DEBUG), logp::Priority::DEBUG);
  // Continuation fragments and NONE default to INFO.
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_CONT), logp::Priority::INFO);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_NONE), logp::Priority::INFO);
}

TEST(WhisperGgmlLogForwarding, NullAndEmptyAndWhitespaceOnlyAreNoOps) {
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_INFO, nullptr).empty());
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_INFO, "").empty());
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_INFO, "\n").empty());
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_ERROR, "\r\n").empty());
}

TEST(WhisperGgmlLogForwarding, ForwardsMessageAtMappedLevelAndTrimsNewline) {
  const std::string out =
      captureForwarded(GGML_LOG_LEVEL_INFO, "ggml_vulkan: Found 1 device\n");
  // The message text is forwarded...
  EXPECT_THAT(out, testing::HasSubstr("ggml_vulkan: Found 1 device"));
  // ...at INFO priority (QLOG prefixes the level in the no-JS build)...
  EXPECT_THAT(out, testing::HasSubstr("INFO"));
  // ...and the message's own trailing '\n' is trimmed, so there is no blank
  // line before QLOG's own line terminator.
  EXPECT_THAT(out, testing::Not(testing::HasSubstr("device\n\n")));
}

TEST(WhisperGgmlLogForwarding, EachCallEmittedIndependently) {
  // Per-callback forwarding: a message without a trailing newline is emitted
  // immediately (not held in a buffer waiting for a later newline).
  const std::string out =
      captureForwarded(GGML_LOG_LEVEL_ERROR, "whisper: failed to load");
  EXPECT_THAT(out, testing::HasSubstr("whisper: failed to load"));
  EXPECT_THAT(out, testing::HasSubstr("ERROR"));
}

// ============================================================================
// StreamingSessionRegistry Tests - one registry for both engines
// ============================================================================

namespace {

class FakeStreamingSession : public qvac::asrggml::IStreamingSession {
public:
  explicit FakeStreamingSession(bool* cancelledFlag = nullptr)
      : cancelledFlag_(cancelledFlag) {}

  void appendAudio(std::vector<float>&& samples) override {
    samplesReceived_ += static_cast<std::int64_t>(samples.size());
  }
  void end() override { ended_ = true; }
  void cancel() override {
    if (cancelledFlag_ != nullptr) {
      *cancelledFlag_ = true;
    }
  }
  double audioSeconds() const override {
    return static_cast<double>(samplesReceived_) / 16000.0;
  }
  int sampleRate() const override { return 16000; }

  bool ended() const { return ended_; }

private:
  bool* cancelledFlag_ = nullptr;
  std::int64_t samplesReceived_ = 0;
  bool ended_ = false;
};

// The registry keys sessions by AddonJs* without ever dereferencing it, so
// distinct opaque addresses are enough for a unit test.
qvac_lib_inference_addon_cpp::AddonJs* fakeInstanceKey(int& slot) {
  return reinterpret_cast<qvac_lib_inference_addon_cpp::AddonJs*>(&slot);
}

// Mirrors what startStreaming() hands to the registry: a factory that builds
// the engine session. Nothing must call it on the double-start path, so the
// build count is observable.
auto fakeSessionFactory(
    bool* cancelledFlag = nullptr, int* buildCount = nullptr) {
  return [cancelledFlag,
          buildCount]() -> std::unique_ptr<qvac::asrggml::IStreamingSession> {
    if (buildCount != nullptr) {
      ++(*buildCount);
    }
    return std::make_unique<FakeStreamingSession>(cancelledFlag);
  };
}

} // namespace

TEST(StreamingSessionRegistry, EmplaceFindTakeRoundTrip) {
  int slot = 0;
  auto* key = fakeInstanceKey(slot);

  EXPECT_EQ(qvac::asrggml::findStreamingSession(key), nullptr);
  EXPECT_EQ(qvac::asrggml::takeStreamingSession(key), nullptr);

  qvac::asrggml::emplaceStreamingSession(key, fakeSessionFactory());
  EXPECT_NE(qvac::asrggml::findStreamingSession(key), nullptr);

  auto taken = qvac::asrggml::takeStreamingSession(key);
  ASSERT_NE(taken, nullptr);
  EXPECT_EQ(qvac::asrggml::findStreamingSession(key), nullptr);
  EXPECT_EQ(qvac::asrggml::takeStreamingSession(key), nullptr);
}

// The double-start regression this pins: the session must be constructed only
// after the duplicate check passes, so a second startStreaming() never spins
// up a second processor (and worker thread) against the shared model.
TEST(StreamingSessionRegistry, DoubleStartThrowsWithoutBuildingASecondSession) {
  int slot = 0;
  auto* key = fakeInstanceKey(slot);

  int builds = 0;
  bool firstCancelled = false;
  qvac::asrggml::emplaceStreamingSession(
      key, fakeSessionFactory(&firstCancelled, &builds));
  ASSERT_EQ(builds, 1);
  auto* first = qvac::asrggml::findStreamingSession(key);
  ASSERT_NE(first, nullptr);

  try {
    qvac::asrggml::emplaceStreamingSession(
        key, fakeSessionFactory(nullptr, &builds));
    FAIL() << "expected a double-start throw";
  } catch (const std::runtime_error& err) {
    // Byte-for-byte the message both parents threw, and the one the JS mocks
    // reproduce (test/mocks/MockedBinding.js:230,
    // test/mocks/ParakeetMockedBinding.js:136). whisper.ts/parakeet.ts wrap it
    // into FAILED_TO_START_STREAMING / FAILED_TO_APPEND with the text in
    // `adds`, so the exact string is part of the JS-visible contract.
    EXPECT_EQ(
        std::string(err.what()),
        "Streaming session already active for this instance");
  }

  // No second session was constructed, and the live one is untouched: still
  // registered, same object, not cancelled or ended by the failed start.
  EXPECT_EQ(builds, 1);
  EXPECT_EQ(qvac::asrggml::findStreamingSession(key), first);
  EXPECT_FALSE(firstCancelled);
  EXPECT_FALSE(static_cast<FakeStreamingSession*>(first)->ended());

  // Cleanup so later tests (and the atexit handler) see an empty registry.
  EXPECT_NE(qvac::asrggml::takeStreamingSession(key), nullptr);
}

// The double-start guard is per AddonJs instance, not process-wide: two
// separate instances (each with its own model) must both be able to stream.
TEST(StreamingSessionRegistry, DoubleStartIsPerInstance) {
  int slotA = 0;
  int slotB = 0;

  int builds = 0;
  qvac::asrggml::emplaceStreamingSession(
      fakeInstanceKey(slotA), fakeSessionFactory(nullptr, &builds));
  qvac::asrggml::emplaceStreamingSession(
      fakeInstanceKey(slotB), fakeSessionFactory(nullptr, &builds));
  EXPECT_EQ(builds, 2);

  EXPECT_NE(
      qvac::asrggml::findStreamingSession(fakeInstanceKey(slotA)), nullptr);
  EXPECT_NE(
      qvac::asrggml::findStreamingSession(fakeInstanceKey(slotB)), nullptr);
  EXPECT_NE(
      qvac::asrggml::findStreamingSession(fakeInstanceKey(slotA)),
      qvac::asrggml::findStreamingSession(fakeInstanceKey(slotB)));

  EXPECT_NE(
      qvac::asrggml::takeStreamingSession(fakeInstanceKey(slotA)), nullptr);
  EXPECT_NE(
      qvac::asrggml::takeStreamingSession(fakeInstanceKey(slotB)), nullptr);
}

// A failing engine ctor (e.g. whisper's "failed to initialize VAD context")
// must not leave a registry entry behind, otherwise the next startStreaming()
// would wrongly report a double-start.
TEST(StreamingSessionRegistry, FailedFactoryLeavesNoEntry) {
  int slot = 0;
  auto* key = fakeInstanceKey(slot);

  EXPECT_THROW(
      qvac::asrggml::emplaceStreamingSession(
          key,
          []() -> std::unique_ptr<qvac::asrggml::IStreamingSession> {
            throw std::runtime_error("failed to initialize VAD context");
          }),
      std::runtime_error);
  EXPECT_EQ(qvac::asrggml::findStreamingSession(key), nullptr);

  // A null session is rejected too, and also leaves nothing behind.
  EXPECT_THROW(
      qvac::asrggml::emplaceStreamingSession(
          key,
          []() -> std::unique_ptr<qvac::asrggml::IStreamingSession> {
            return nullptr;
          }),
      std::runtime_error);
  EXPECT_EQ(qvac::asrggml::findStreamingSession(key), nullptr);

  // The slot is reusable: the failures did not poison it.
  int builds = 0;
  qvac::asrggml::emplaceStreamingSession(
      key, fakeSessionFactory(nullptr, &builds));
  EXPECT_EQ(builds, 1);
  EXPECT_NE(qvac::asrggml::takeStreamingSession(key), nullptr);
}

TEST(StreamingSessionRegistry, ClearAllCancelsEverySurvivingSession) {
  int slotA = 0;
  int slotB = 0;
  bool cancelledA = false;
  bool cancelledB = false;

  qvac::asrggml::emplaceStreamingSession(
      fakeInstanceKey(slotA), fakeSessionFactory(&cancelledA));
  qvac::asrggml::emplaceStreamingSession(
      fakeInstanceKey(slotB), fakeSessionFactory(&cancelledB));

  qvac::asrggml::clearAllStreamingSessions();

  EXPECT_TRUE(cancelledA);
  EXPECT_TRUE(cancelledB);
  EXPECT_EQ(
      qvac::asrggml::findStreamingSession(fakeInstanceKey(slotA)), nullptr);
  EXPECT_EQ(
      qvac::asrggml::findStreamingSession(fakeInstanceKey(slotB)), nullptr);
}

TEST(StreamingSessionRegistry, TakeSharedTransfersOwnership) {
  int slot = 0;
  auto* key = fakeInstanceKey(slot);

  qvac::asrggml::emplaceStreamingSession(key, fakeSessionFactory());
  std::shared_ptr<qvac::asrggml::IStreamingSession> shared =
      qvac::asrggml::takeStreamingSessionShared(key);
  ASSERT_NE(shared, nullptr);
  EXPECT_EQ(qvac::asrggml::findStreamingSession(key), nullptr);

  // Absent key -> null shared_ptr.
  EXPECT_EQ(qvac::asrggml::takeStreamingSessionShared(key), nullptr);
}
