// Per-segment data whisper.cpp reports and the binding now forwards:
// language, no-speech probability, tinydiarize speaker turns, token-level
// timing, plus the carry_initial_prompt decode flag. The model-backed cases
// need ggml-tiny.bin (see test_whisper_lifecycle.cpp) and jfk.wav.

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper/WhisperConfig.hpp"
#include "model-interface/whisper/WhisperModel.hpp"

namespace {
using qvac::asrggml::whisper::Transcript;
using qvac::asrggml::whisper::WhisperConfig;
using qvac::asrggml::whisper::WhisperModel;

std::string whisperModelPath() {
  const char* env = std::getenv("QVAC_TEST_WHISPER_MODEL");
  return env != nullptr ? env : "../../../models/ggml-tiny.bin";
}

const std::filesystem::path JFK_WAV =
    "../../../examples/parakeet-samples/jfk.wav";

// PCM16 mono 16 kHz WAV -> float samples (reads the "data" chunk).
std::vector<float> readWav(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  std::vector<uint8_t> bytes(
      (std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  size_t offset = 12;
  while (offset + 8 <= bytes.size()) {
    uint32_t chunkSize = 0;
    std::memcpy(&chunkSize, &bytes[offset + 4], sizeof(chunkSize));
    if (std::memcmp(&bytes[offset], "data", 4) == 0) {
      const size_t end = std::min(bytes.size(), offset + 8 + chunkSize);
      std::vector<uint8_t> pcm(bytes.begin() + offset + 8, bytes.begin() + end);
      return WhisperModel::preprocessAudioData(pcm, "s16le");
    }
    offset += 8 + chunkSize;
  }
  return {};
}

class WhisperSegmentFieldsTest : public ::testing::Test {
protected:
  void SetUp() override {
    if (!std::filesystem::exists(whisperModelPath()) ||
        !std::filesystem::exists(JFK_WAV)) {
      GTEST_SKIP() << "Stage ggml-tiny.bin or set QVAC_TEST_WHISPER_MODEL";
    }
    config_.whisperContextCfg["model"] = whisperModelPath();
    config_.whisperContextCfg["use_gpu"] = false;
    config_.whisperMainCfg["n_threads"] = 2.0;
    config_.whisperMainCfg["language"] = std::string("auto");
    audio_ = readWav(JFK_WAV);
    ASSERT_FALSE(audio_.empty());
  }

  std::vector<Transcript> transcribe() {
    WhisperModel model(config_);
    model.load();
    model.process(audio_);
    return model.takeOutput();
  }

  WhisperConfig config_;
  std::vector<float> audio_;
};

} // namespace

TEST(WhisperSegmentFieldDefaults, OptionalFieldsStartUnset) {
  const Transcript transcript;
  EXPECT_TRUE(transcript.language.empty());
  EXPECT_FLOAT_EQ(transcript.noSpeechProb, -1.0F);
  EXPECT_FALSE(transcript.speakerTurnNext.has_value());
  EXPECT_FALSE(transcript.tokens.has_value());
}

TEST(WhisperSegmentFieldDefaults, CarryInitialPromptReachesFullParams) {
  WhisperConfig config;
  EXPECT_FALSE(toWhisperFullParams(config).carry_initial_prompt);
  config.whisperMainCfg["carry_initial_prompt"] = true;
  EXPECT_TRUE(toWhisperFullParams(config).carry_initial_prompt);
}

TEST_F(WhisperSegmentFieldsTest, SegmentsCarryDetectedLanguageAndNoSpeechProb) {
  const auto segments = transcribe();
  ASSERT_FALSE(segments.empty());
  for (const auto& segment : segments) {
    EXPECT_EQ(segment.language, "en") << segment.text;
    EXPECT_GE(segment.noSpeechProb, 0.0F);
    EXPECT_LE(segment.noSpeechProb, 1.0F);
    EXPECT_FALSE(segment.tokens.has_value());
    EXPECT_FALSE(segment.speakerTurnNext.has_value());
  }
}

TEST_F(WhisperSegmentFieldsTest, TokenTimestampsAddTextTokens) {
  config_.whisperMainCfg["token_timestamps"] = true;
  const auto segments = transcribe();
  ASSERT_FALSE(segments.empty());
  for (const auto& segment : segments) {
    ASSERT_TRUE(segment.tokens.has_value());
    ASSERT_FALSE(segment.tokens->empty()) << segment.text;
    std::string joined;
    for (const auto& token : *segment.tokens) {
      joined += token.text;
      EXPECT_LE(token.start, token.end);
      EXPECT_GT(token.probability, 0.0F);
      EXPECT_LE(token.probability, 1.0F);
    }
    // Special tokens are skipped, so the text tokens rebuild the segment.
    EXPECT_EQ(joined, segment.text);
  }
}

TEST_F(WhisperSegmentFieldsTest, TdrzReportsSpeakerTurnPerSegment) {
  config_.whisperMainCfg["tdrz_enable"] = true;
  const auto segments = transcribe();
  ASSERT_FALSE(segments.empty());
  for (const auto& segment : segments) {
    EXPECT_TRUE(segment.speakerTurnNext.has_value());
  }
}
