#include <any>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <random>
#include <string>
#include <system_error>
#include <vector>

#include <gtest/gtest.h>
#include <parakeet/moss_transcribe.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/moss/MossTranscribeConfig.hpp"
#include "model-interface/moss/MossTranscribeModel.hpp"

using qvac::asrggml::moss::MOSS_TRANSCRIBE_SAMPLE_RATE;
using qvac::asrggml::moss::MossTranscribeConfig;
using qvac::asrggml::moss::MossTranscribeModel;
using qvac::asrggml::moss::MossTranscribeRequest;

namespace {

constexpr char MODEL_ENV[] = "QVAC_TEST_MOSS_TRANSCRIBE_GGUF";
constexpr char AUDIO_ENV[] = "QVAC_TEST_MOSS_TRANSCRIBE_AUDIO";
constexpr char GPU_ENV[] = "QVAC_TEST_MOSS_TRANSCRIBE_GPU";
constexpr const char* STUB_DIR_PREFIX = "qvac-asr-ggml-moss-tests-";
constexpr const char* STUB_CONTENTS = "stub";
constexpr int CONFIGURED_THREADS = 3;
constexpr int REQUESTED_NEW_TOKENS = 512;
constexpr int REAL_AUDIO_SECONDS = 20;
constexpr int REAL_NEW_TOKENS = 256;
constexpr float INT16_SCALE = 32768.0f;
constexpr const char* BACKENDS_ROOT = "/opt/qvac/backends";
constexpr const char* PROMPT = "Transcribe with speaker labels.";

std::filesystem::path createStubDir() {
  std::random_device entropy;
  auto dir = std::filesystem::temp_directory_path() /
             (std::string(STUB_DIR_PREFIX) + std::to_string(entropy()));
  std::filesystem::create_directories(dir);
  return dir;
}

class StubDir {
public:
  StubDir() : path_(createStubDir()) {}
  ~StubDir() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  StubDir(const StubDir&) = delete;
  StubDir& operator=(const StubDir&) = delete;

  const std::filesystem::path& path() const { return path_; }

private:
  std::filesystem::path path_;
};

std::string stubModel() {
  static const StubDir dir;
  const auto path = dir.path() / "moss-transcribe-diarize-stub.gguf";
  std::ofstream out(path, std::ios::binary);
  out << STUB_CONTENTS;
  return path.string();
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

MossTranscribeConfig stubConfig() {
  MossTranscribeConfig cfg;
  cfg.modelPath = stubModel();
  return cfg;
}

parakeet::moss::TranscribeResult twoSpeakerResult() {
  parakeet::moss::TranscribeResult result;
  result.segments.push_back({0.5, 2.25, "S01", "Hola."});
  result.segments.push_back({2.5, 4.0, "S02", "Buenas tardes."});
  return result;
}

std::vector<float> int16ToFloat(const std::vector<int16_t>& pcm) {
  std::vector<float> samples;
  samples.reserve(pcm.size());
  for (const int16_t sample : pcm) {
    samples.push_back(static_cast<float>(sample) / INT16_SCALE);
  }
  return samples;
}

std::vector<float> readRawPcm(const std::string& path, size_t samples) {
  std::ifstream in(path, std::ios::binary);
  std::vector<int16_t> pcm(samples);
  in.read(reinterpret_cast<char*>(pcm.data()), pcm.size() * sizeof(int16_t));
  pcm.resize(static_cast<size_t>(in.gcount()) / sizeof(int16_t));
  return int16ToFloat(pcm);
}

bool statPresent(const MossTranscribeModel& model, const std::string& key) {
  for (const auto& entry : model.runtimeStats()) {
    if (entry.first == key)
      return true;
  }
  return false;
}

void expectStatsPresent(
    const MossTranscribeModel& model, std::initializer_list<const char*> keys) {
  for (const char* key : keys) {
    EXPECT_TRUE(statPresent(model, key)) << key;
  }
}

} // namespace

TEST(MossTranscribeValidate, EmptyModelPathRejected) {
  EXPECT_THROW(
      MossTranscribeModel{MossTranscribeConfig{}}, qvac_errors::StatusError);
}

TEST(MossTranscribeValidate, MissingModelFileRejected) {
  MossTranscribeConfig cfg;
  cfg.modelPath = "/nonexistent/moss-transcribe-diarize.gguf";
  EXPECT_THROW(MossTranscribeModel{cfg}, qvac_errors::StatusError);
}

TEST(MossTranscribeValidate, NegativeThreadsRejected) {
  auto cfg = stubConfig();
  cfg.maxThreads = -1;
  EXPECT_THROW(MossTranscribeModel{cfg}, qvac_errors::StatusError);
}

TEST(MossTranscribeValidate, StubConfigAccepted) {
  EXPECT_NO_THROW(MossTranscribeModel{stubConfig()});
}

TEST(MossTranscribeEngineOptions, MapsModelThreadsAndGpu) {
  auto cfg = stubConfig();
  cfg.maxThreads = CONFIGURED_THREADS;
  cfg.useGPU = true;
  const auto options = MossTranscribeModel::toEngineOptions(cfg);
  EXPECT_EQ(options.model_path, cfg.modelPath);
  EXPECT_EQ(options.n_threads, CONFIGURED_THREADS);
  EXPECT_TRUE(options.use_gpu);
}

TEST(MossTranscribeEngineOptions, ZeroThreadsKeepsEngineDefault) {
  EXPECT_EQ(
      MossTranscribeModel::toEngineOptions(stubConfig()).n_threads,
      parakeet::moss::TranscribeOptions{}.n_threads);
}

TEST(MossTranscribeEngineOptions, BackendsDirIsResolved) {
  auto cfg = stubConfig();
  cfg.backendsDir = BACKENDS_ROOT;
  const auto options = MossTranscribeModel::toEngineOptions(cfg);
  EXPECT_EQ(options.backends_dir.rfind(BACKENDS_ROOT, 0), 0u);
}

TEST(MossTranscribeRequestMapping, PromptHotwordsAndLimitAreForwarded) {
  MossTranscribeRequest request;
  request.prompt = PROMPT;
  request.hotwords = {"QVAC", "vcpkg"};
  request.maxNewTokens = REQUESTED_NEW_TOKENS;
  const auto engineRequest = MossTranscribeModel::toEngineRequest(request);
  EXPECT_EQ(engineRequest.prompt, PROMPT);
  EXPECT_EQ(engineRequest.hotwords, request.hotwords);
  EXPECT_EQ(engineRequest.max_new_tokens, REQUESTED_NEW_TOKENS);
}

TEST(MossTranscribeRequestMapping, EmptyRequestKeepsModelDefaults) {
  const auto engineRequest =
      MossTranscribeModel::toEngineRequest(MossTranscribeRequest{});
  EXPECT_TRUE(engineRequest.prompt.empty());
  EXPECT_TRUE(engineRequest.hotwords.empty());
  EXPECT_EQ(engineRequest.max_new_tokens, 0);
}

TEST(MossTranscribeSpeakers, LabelsBecomeZeroBasedIds) {
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("S01"), 0);
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("S02"), 1);
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("S12"), 11);
}

TEST(MossTranscribeSpeakers, MalformedLabelsHaveNoId) {
  EXPECT_EQ(MossTranscribeModel::speakerIdOf(""), -1);
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("S"), -1);
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("X01"), -1);
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("S0x"), -1);
  EXPECT_EQ(MossTranscribeModel::speakerIdOf("S99999999999"), -1);
}

TEST(MossTranscribeTranscripts, SegmentsKeepTextTimesAndSpeakers) {
  const auto transcripts =
      MossTranscribeModel::toTranscripts(twoSpeakerResult());
  ASSERT_EQ(transcripts.size(), 2u);
  EXPECT_EQ(transcripts[0].text, "Hola.");
  EXPECT_FLOAT_EQ(transcripts[0].start, 0.5f);
  EXPECT_FLOAT_EQ(transcripts[0].end, 2.25f);
  EXPECT_EQ(transcripts[0].speaker, "S01");
  EXPECT_EQ(transcripts[0].speakerId, 0);
  EXPECT_EQ(transcripts[1].speaker, "S02");
  EXPECT_EQ(transcripts[1].speakerId, 1);
  EXPECT_EQ(transcripts[1].id, 1u);
}

TEST(MossTranscribeModelTest, NotLoadedUntilActivated) {
  MossTranscribeModel model{stubConfig()};
  EXPECT_FALSE(model.isLoaded());
}

TEST(MossTranscribeModelTest, InvalidGgufFailsToLoadWithoutCrashing) {
  MossTranscribeModel model{stubConfig()};
  EXPECT_ANY_THROW(model.load());
  EXPECT_FALSE(model.isLoaded());
}

TEST(MossTranscribeModelTest, ProcessBeforeLoadThrows) {
  MossTranscribeModel model{stubConfig()};
  MossTranscribeModel::AnyInput input;
  input.samples.assign(MOSS_TRANSCRIBE_SAMPLE_RATE, 0.0f);
  EXPECT_ANY_THROW(model.process(std::any(input)));
}

TEST(MossTranscribeModelTest, ProcessRejectsForeignInput) {
  MossTranscribeModel model{stubConfig()};
  EXPECT_THROW(
      model.process(std::any(std::vector<float>(16, 0.0f))),
      qvac_errors::StatusError);
}

TEST(MossTranscribeModelTest, RuntimeStatsCarryTheTranscribeKeys) {
  MossTranscribeModel model{stubConfig()};
  expectStatsPresent(
      model,
      {"totalTime",
       "realTimeFactor",
       "audioDurationMs",
       "segments",
       "audioTokens",
       "promptTokens",
       "generatedTokens",
       "encodeMs",
       "prefillMs",
       "decodeMs",
       "backendDevice",
       "backendId"});
}

TEST(MossTranscribeRealGguf, TranscribesSpeechIntoLabelledSegments) {
  const std::string modelPath = envOrEmpty(MODEL_ENV);
  const std::string audioPath = envOrEmpty(AUDIO_ENV);
  if (modelPath.empty() || audioPath.empty()) {
    GTEST_SKIP() << "set QVAC_TEST_MOSS_TRANSCRIBE_GGUF and "
                    "QVAC_TEST_MOSS_TRANSCRIBE_AUDIO (16 kHz s16le raw) to "
                    "run this";
  }
  MossTranscribeConfig cfg;
  cfg.modelPath = modelPath;
  cfg.useGPU = !envOrEmpty(GPU_ENV).empty();
  MossTranscribeModel model{cfg};
  ASSERT_NO_THROW(model.load());

  MossTranscribeModel::AnyInput input;
  input.samples = readRawPcm(
      audioPath,
      static_cast<size_t>(REAL_AUDIO_SECONDS) * MOSS_TRANSCRIBE_SAMPLE_RATE);
  input.request.maxNewTokens = REAL_NEW_TOKENS;
  const auto transcripts = std::any_cast<MossTranscribeModel::Output>(
      model.process(std::any(input)));
  ASSERT_FALSE(transcripts.empty());
  EXPECT_FALSE(transcripts.front().text.empty());
  EXPECT_GE(transcripts.front().speakerId, 0);
  EXPECT_LE(transcripts.front().start, transcripts.front().end);
}
