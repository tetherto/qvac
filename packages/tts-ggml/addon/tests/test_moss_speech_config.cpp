#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <random>
#include <string>
#include <system_error>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <tts-cpp/moss/speech.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/moss/MossSpeechConfig.hpp"
#include "model-interface/moss/MossSpeechModel.hpp"

using qvac::ttsggml::moss::MOSS_SPEECH_NATIVE_SAMPLE_RATE;
using qvac::ttsggml::moss::MossSpeechAudio;
using qvac::ttsggml::moss::MossSpeechCall;
using qvac::ttsggml::moss::MossSpeechConfig;
using qvac::ttsggml::moss::MossSpeechModel;
using qvac::ttsggml::moss::MossSpeechTurn;
using qvac_errors::StatusError;

namespace {

constexpr char MOSS_SPEECH_MODEL_ENV[] = "QVAC_TEST_MOSS_SPEECH_GGUF";
constexpr char MOSS_SPEECH_CODEC_ENV[] = "QVAC_TEST_MOSS_SPEECH_CODEC_GGUF";
constexpr char MOSS_SPEECH_GPU_ENV[] = "QVAC_TEST_MOSS_SPEECH_GPU";
constexpr const char* STUB_DIR_PREFIX = "qvac-tts-ggml-moss-speech-tests-";
constexpr const char* STUB_CONTENTS = "stub";
constexpr int CONFIGURED_SEED = 7;
constexpr int CONFIGURED_THREADS = 3;
constexpr int USER_SAMPLE_RATE = 16000;
constexpr int VOICE_SAMPLE_RATE = 24000;
constexpr size_t USER_SAMPLES = 1600;
constexpr size_t VOICE_SAMPLES = 2400;
constexpr float USER_LEVEL = 0.1f;
constexpr float REPLY_SECONDS = 4.5f;
constexpr int REQUESTED_NEW_TOKENS = 300;
constexpr float REQUESTED_TEMPERATURE = 0.5f;
constexpr float REQUESTED_TOP_P = 0.9f;
constexpr int REQUESTED_TOP_K = 10;
constexpr int REAL_GGUF_NEW_TOKENS = 40;
constexpr float REAL_GGUF_REPLY_SECONDS = 1.0f;
constexpr int ALL_GPU_LAYERS = 99;
constexpr const char* BACKENDS_ROOT = "/opt/qvac/backends";
constexpr const char* SYSTEM_TEXT = "Answer briefly.";

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

std::string stubFile(const std::string& name) {
  static const StubDir dir;
  const auto path = dir.path() / name;
  std::ofstream out(path, std::ios::binary);
  out << STUB_CONTENTS;
  return path.string();
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

MossSpeechConfig stubConfig() {
  MossSpeechConfig cfg;
  cfg.modelPath = stubFile("moss-speech-stub.gguf");
  cfg.codecPath = stubFile("moss-speech-codec-stub.gguf");
  return cfg;
}

MossSpeechAudio tone(size_t samples, int sampleRate) {
  return MossSpeechAudio{std::vector<float>(samples, USER_LEVEL), sampleRate};
}

MossSpeechCall spokenQuestion() {
  MossSpeechCall call;
  call.messages.push_back(
      MossSpeechTurn{"user", "", tone(USER_SAMPLES, USER_SAMPLE_RATE)});
  return call;
}

MossSpeechCall fullCall() {
  MossSpeechCall call;
  call.messages.push_back(MossSpeechTurn{"system", SYSTEM_TEXT, {}});
  call.messages.push_back(
      MossSpeechTurn{"user", "", tone(USER_SAMPLES, USER_SAMPLE_RATE)});
  call.voice = tone(VOICE_SAMPLES, VOICE_SAMPLE_RATE);
  call.textReply = true;
  call.greedy = true;
  call.maxReplySeconds = REPLY_SECONDS;
  call.maxNewTokens = REQUESTED_NEW_TOKENS;
  call.temperature = REQUESTED_TEMPERATURE;
  call.topP = REQUESTED_TOP_P;
  call.topK = REQUESTED_TOP_K;
  return call;
}

bool statPresent(const MossSpeechModel& model, const std::string& key) {
  for (const auto& entry : model.runtimeStats()) {
    if (entry.first == key)
      return true;
  }
  return false;
}

void expectStatsPresent(
    const MossSpeechModel& model, std::initializer_list<const char*> keys) {
  for (const char* key : keys) {
    EXPECT_TRUE(statPresent(model, key)) << key;
  }
}

} // namespace

TEST(MossSpeechValidate, EmptyPathsRejected) {
  EXPECT_THROW(MossSpeechModel{MossSpeechConfig{}}, StatusError);
}

TEST(MossSpeechValidate, MissingCodecRejected) {
  auto cfg = stubConfig();
  cfg.codecPath.clear();
  EXPECT_THROW(MossSpeechModel{cfg}, StatusError);
}

TEST(MossSpeechValidate, MissingModelFileRejected) {
  auto cfg = stubConfig();
  cfg.modelPath = "/nonexistent/moss-speech.gguf";
  EXPECT_THROW(MossSpeechModel{cfg}, StatusError);
}

TEST(MossSpeechValidate, StubConfigAccepted) {
  EXPECT_NO_THROW(MossSpeechModel{stubConfig()});
}

TEST(MossSpeechValidate, ThreadsNonNegative) {
  auto cfg = stubConfig();
  cfg.threads = -1;
  EXPECT_THROW(MossSpeechModel{cfg}, StatusError);
}

TEST(MossSpeechValidate, UseGpuNGpuLayersConflictRejected) {
  auto cfg = stubConfig();
  cfg.useGpu = false;
  cfg.nGpuLayers = ALL_GPU_LAYERS;
  EXPECT_THROW(MossSpeechModel{cfg}, StatusError);
}

TEST(MossSpeechEngineOptions, MapsPathsThreadsAndGpu) {
  auto cfg = stubConfig();
  cfg.threads = CONFIGURED_THREADS;
  cfg.useGpu = true;
  const auto opts = MossSpeechModel::toEngineOptions(cfg);
  EXPECT_EQ(opts.model_path, cfg.modelPath);
  EXPECT_EQ(opts.codec_path, cfg.codecPath);
  EXPECT_EQ(opts.n_threads, CONFIGURED_THREADS);
  EXPECT_TRUE(opts.use_gpu);
}

TEST(MossSpeechEngineOptions, NGpuLayersDecidesGpuUse) {
  auto cfg = stubConfig();
  cfg.nGpuLayers = ALL_GPU_LAYERS;
  EXPECT_TRUE(MossSpeechModel::toEngineOptions(cfg).use_gpu);
  cfg.nGpuLayers = 0;
  EXPECT_FALSE(MossSpeechModel::toEngineOptions(cfg).use_gpu);
}

TEST(MossSpeechEngineOptions, ZeroThreadsKeepsEngineDefault) {
  auto cfg = stubConfig();
  cfg.threads = 0;
  EXPECT_EQ(
      MossSpeechModel::toEngineOptions(cfg).n_threads,
      tts_cpp::moss::SpeechOptions{}.n_threads);
}

TEST(MossSpeechEngineOptions, BackendsDirIsResolved) {
  auto cfg = stubConfig();
  cfg.backendsDir = BACKENDS_ROOT;
  const auto opts = MossSpeechModel::toEngineOptions(cfg);
  EXPECT_EQ(opts.backends_dir.rfind(BACKENDS_ROOT, 0), 0u);
}

TEST(MossSpeechRequest, SpokenQuestionUsesEngineDefaults) {
  const auto request =
      MossSpeechModel::toRequest(stubConfig(), spokenQuestion());
  const tts_cpp::moss::SpeechRequest defaults;
  ASSERT_EQ(request.messages.size(), 1u);
  EXPECT_EQ(request.messages[0].role, tts_cpp::moss::SpeechRole::User);
  EXPECT_EQ(request.messages[0].audio.size(), USER_SAMPLES);
  EXPECT_EQ(request.messages[0].sample_rate, USER_SAMPLE_RATE);
  EXPECT_TRUE(request.voice.empty());
  EXPECT_FALSE(request.text_reply);
  EXPECT_FALSE(request.greedy);
  EXPECT_FLOAT_EQ(request.temperature, defaults.temperature);
  EXPECT_FLOAT_EQ(request.top_p, defaults.top_p);
  EXPECT_EQ(request.top_k, defaults.top_k);
  EXPECT_EQ(request.max_new_tokens, defaults.max_new_tokens);
  EXPECT_FLOAT_EQ(request.max_reply_seconds, defaults.max_reply_seconds);
}

TEST(MossSpeechRequest, PerCallFieldsAreForwarded) {
  const auto request = MossSpeechModel::toRequest(stubConfig(), fullCall());
  ASSERT_EQ(request.messages.size(), 2u);
  EXPECT_EQ(request.messages[0].role, tts_cpp::moss::SpeechRole::System);
  EXPECT_EQ(request.messages[0].text, SYSTEM_TEXT);
  EXPECT_EQ(request.voice.size(), VOICE_SAMPLES);
  EXPECT_EQ(request.voice_sample_rate, VOICE_SAMPLE_RATE);
  EXPECT_TRUE(request.text_reply);
  EXPECT_TRUE(request.greedy);
  EXPECT_FLOAT_EQ(request.max_reply_seconds, REPLY_SECONDS);
  EXPECT_EQ(request.max_new_tokens, REQUESTED_NEW_TOKENS);
  EXPECT_FLOAT_EQ(request.temperature, REQUESTED_TEMPERATURE);
  EXPECT_FLOAT_EQ(request.top_p, REQUESTED_TOP_P);
  EXPECT_EQ(request.top_k, REQUESTED_TOP_K);
}

TEST(MossSpeechRequest, AssistantRoleIsMapped) {
  MossSpeechCall call = spokenQuestion();
  call.messages.insert(
      call.messages.begin(), MossSpeechTurn{"assistant", "Hi.", {}});
  const auto request = MossSpeechModel::toRequest(stubConfig(), call);
  EXPECT_EQ(request.messages[0].role, tts_cpp::moss::SpeechRole::Assistant);
}

TEST(MossSpeechRequest, UnknownRoleRejected) {
  MossSpeechCall call = spokenQuestion();
  call.messages[0].role = "narrator";
  EXPECT_THROW(MossSpeechModel::toRequest(stubConfig(), call), StatusError);
}

TEST(MossSpeechRequest, SeedComesFromTheConfig) {
  auto cfg = stubConfig();
  cfg.seed = CONFIGURED_SEED;
  EXPECT_EQ(
      MossSpeechModel::toRequest(cfg, spokenQuestion()).seed,
      static_cast<uint32_t>(CONFIGURED_SEED));
}

TEST(MossSpeechModelTest, ReportsTheNativeSampleRate) {
  MossSpeechModel model{stubConfig()};
  EXPECT_EQ(model.sampleRate(), MOSS_SPEECH_NATIVE_SAMPLE_RATE);
}

TEST(MossSpeechModelTest, NotLoadedUntilActivated) {
  MossSpeechModel model{stubConfig()};
  EXPECT_FALSE(model.isLoaded());
}

TEST(MossSpeechModelTest, InvalidGgufFailsToLoadWithoutCrashing) {
  MossSpeechModel model{stubConfig()};
  EXPECT_ANY_THROW(model.load());
  EXPECT_FALSE(model.isLoaded());
}

TEST(MossSpeechModelTest, ProcessBeforeLoadThrows) {
  MossSpeechModel model{stubConfig()};
  EXPECT_ANY_THROW(
      model.process(std::any(MossSpeechModel::AnyInput{spokenQuestion()})));
}

TEST(MossSpeechModelTest, ProcessRejectsForeignInput) {
  MossSpeechModel model{stubConfig()};
  EXPECT_THROW(model.process(std::any(std::string(SYSTEM_TEXT))), StatusError);
}

TEST(MossSpeechModelTest, RuntimeStatsCarryTheSpeechKeys) {
  MossSpeechModel model{stubConfig()};
  expectStatsPresent(
      model,
      {"totalTime",
       "realTimeFactor",
       "audioDurationMs",
       "totalSamples",
       "promptTokens",
       "generatedTokens",
       "replyTokens",
       "truncated",
       "encodeMs",
       "prefillMs",
       "generateMs",
       "decodeMs",
       "backendDevice",
       "backendId",
       "gpuUnsupported"});
}

TEST(MossSpeechReload, InvalidConfigKeepsThePreviousOne) {
  MossSpeechModel model{stubConfig()};
  const std::string previous = model.config().modelPath;
  EXPECT_THROW(model.reloadWith(MossSpeechConfig{}), StatusError);
  EXPECT_EQ(model.config().modelPath, previous);
}

TEST(MossSpeechRealGguf, AnswersASpokenTurnWithSpeechAndText) {
  const std::string modelPath = envOrEmpty(MOSS_SPEECH_MODEL_ENV);
  const std::string codecPath = envOrEmpty(MOSS_SPEECH_CODEC_ENV);
  if (modelPath.empty() || codecPath.empty()) {
    GTEST_SKIP() << "set QVAC_TEST_MOSS_SPEECH_GGUF and "
                    "QVAC_TEST_MOSS_SPEECH_CODEC_GGUF to run this";
  }
  MossSpeechConfig cfg;
  cfg.modelPath = modelPath;
  cfg.codecPath = codecPath;
  cfg.seed = CONFIGURED_SEED;
  if (!envOrEmpty(MOSS_SPEECH_GPU_ENV).empty())
    cfg.useGpu = true;
  MossSpeechModel model{cfg};
  ASSERT_NO_THROW(model.load());

  MossSpeechCall call = spokenQuestion();
  call.maxNewTokens = REAL_GGUF_NEW_TOKENS;
  call.maxReplySeconds = REAL_GGUF_REPLY_SECONDS;
  const auto reply = std::any_cast<MossSpeechModel::Output>(
      model.process(std::any(MossSpeechModel::AnyInput{call})));
  EXPECT_LE(
      reply.pcm.size(),
      static_cast<size_t>(
          (REAL_GGUF_REPLY_SECONDS + 1.0f) * MOSS_SPEECH_NATIVE_SAMPLE_RATE));
}
