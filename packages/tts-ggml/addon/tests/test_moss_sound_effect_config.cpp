#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <system_error>
#include <variant>

#include <gtest/gtest.h>
#include <tts-cpp/moss/sound_effect.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/moss/MossSoundEffectConfig.hpp"
#include "model-interface/moss/MossSoundEffectModel.hpp"

using qvac::ttsggml::moss::MOSS_SFX_NATIVE_SAMPLE_RATE;
using qvac::ttsggml::moss::MossSoundEffectConfig;
using qvac::ttsggml::moss::MossSoundEffectModel;
using qvac_errors::StatusError;

namespace {

constexpr char MOSS_SFX_ENV[] = "QVAC_TEST_MOSS_SFX_GGUF";
constexpr char MOSS_SFX_GPU_ENV[] = "QVAC_TEST_MOSS_SFX_GPU";
constexpr const char* STUB_DIR_PREFIX = "qvac-tts-ggml-moss-sfx-tests-";
constexpr const char* STUB_CONTENTS = "stub";
constexpr int CONFIGURED_SEED = 7;
constexpr int CONFIGURED_THREADS = 3;
constexpr int REQUESTED_STEPS = 20;
constexpr float REQUESTED_GUIDANCE = 3.5f;
constexpr float REQUESTED_SHIFT = 4.0f;
constexpr double REQUESTED_SECONDS = 2.5;
constexpr double DEFAULT_SECONDS = 10.0;
constexpr const char* BACKENDS_ROOT = "/opt/qvac/backends";
constexpr const char* PROMPT = "Rain on a tin roof.";
constexpr const char* NEGATIVE_PROMPT = "music";
constexpr double REAL_GGUF_SECONDS = 0.5;
constexpr int REAL_GGUF_STEPS = 2;

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

MossSoundEffectConfig stubConfig() {
  MossSoundEffectConfig cfg;
  cfg.modelPath = stubFile("moss-sfx-stub.gguf");
  return cfg;
}

MossSoundEffectModel::AnyInput promptOnly() {
  MossSoundEffectModel::AnyInput input;
  input.text = PROMPT;
  return input;
}

MossSoundEffectModel::AnyInput fullCall() {
  MossSoundEffectModel::AnyInput input = promptOnly();
  input.call.seconds = REQUESTED_SECONDS;
  input.call.steps = REQUESTED_STEPS;
  input.call.guidance = REQUESTED_GUIDANCE;
  input.call.shift = REQUESTED_SHIFT;
  input.call.negativePrompt = NEGATIVE_PROMPT;
  return input;
}

bool statPresent(const MossSoundEffectModel& model, const std::string& key) {
  for (const auto& entry : model.runtimeStats()) {
    if (entry.first == key)
      return true;
  }
  return false;
}

} // namespace

TEST(MossSoundEffectValidate, EmptyModelPathRejected) {
  EXPECT_THROW(MossSoundEffectModel{MossSoundEffectConfig{}}, StatusError);
}

TEST(MossSoundEffectValidate, MissingModelFileRejected) {
  MossSoundEffectConfig cfg;
  cfg.modelPath = "/nonexistent/moss-sfx.gguf";
  EXPECT_THROW(MossSoundEffectModel{cfg}, StatusError);
}

TEST(MossSoundEffectValidate, StubConfigAccepted) {
  EXPECT_NO_THROW(MossSoundEffectModel{stubConfig()});
}

TEST(MossSoundEffectValidate, ThreadsNonNegative) {
  auto cfg = stubConfig();
  cfg.threads = -1;
  EXPECT_THROW(MossSoundEffectModel{cfg}, StatusError);
}

TEST(MossSoundEffectValidate, UseGpuNGpuLayersConflictRejected) {
  auto cfg = stubConfig();
  cfg.useGpu = true;
  cfg.nGpuLayers = 0;
  EXPECT_THROW(MossSoundEffectModel{cfg}, StatusError);
}

TEST(MossSoundEffectEngineOptions, MapsModelThreadsAndGpu) {
  auto cfg = stubConfig();
  cfg.threads = CONFIGURED_THREADS;
  cfg.useGpu = true;
  const auto opts = MossSoundEffectModel::toEngineOptions(cfg);
  EXPECT_EQ(opts.model_path, cfg.modelPath);
  EXPECT_EQ(opts.n_threads, CONFIGURED_THREADS);
  EXPECT_TRUE(opts.use_gpu);
}

TEST(MossSoundEffectEngineOptions, NGpuLayersDecidesGpuUse) {
  auto cfg = stubConfig();
  cfg.nGpuLayers = 99;
  EXPECT_TRUE(MossSoundEffectModel::toEngineOptions(cfg).use_gpu);
  cfg.nGpuLayers = 0;
  EXPECT_FALSE(MossSoundEffectModel::toEngineOptions(cfg).use_gpu);
}

TEST(MossSoundEffectEngineOptions, ZeroThreadsKeepsEngineDefault) {
  auto cfg = stubConfig();
  cfg.threads = 0;
  EXPECT_EQ(
      MossSoundEffectModel::toEngineOptions(cfg).n_threads,
      tts_cpp::moss::SoundEffectOptions{}.n_threads);
}

TEST(MossSoundEffectEngineOptions, BackendsDirIsResolved) {
  auto cfg = stubConfig();
  cfg.backendsDir = BACKENDS_ROOT;
  const auto opts = MossSoundEffectModel::toEngineOptions(cfg);
  EXPECT_EQ(opts.backends_dir.rfind(BACKENDS_ROOT, 0), 0u);
}

TEST(MossSoundEffectRequest, PromptOnlyUsesModelDefaults) {
  const auto request =
      MossSoundEffectModel::toRequest(stubConfig(), promptOnly());
  EXPECT_EQ(request.prompt, PROMPT);
  EXPECT_TRUE(request.negative_prompt.empty());
  EXPECT_DOUBLE_EQ(request.seconds, DEFAULT_SECONDS);
  EXPECT_EQ(request.steps, 0);
  EXPECT_FLOAT_EQ(request.guidance, 0.0f);
  EXPECT_FLOAT_EQ(request.shift, 0.0f);
}

TEST(MossSoundEffectRequest, PerCallFieldsAreForwarded) {
  const auto request =
      MossSoundEffectModel::toRequest(stubConfig(), fullCall());
  EXPECT_DOUBLE_EQ(request.seconds, REQUESTED_SECONDS);
  EXPECT_EQ(request.steps, REQUESTED_STEPS);
  EXPECT_FLOAT_EQ(request.guidance, REQUESTED_GUIDANCE);
  EXPECT_FLOAT_EQ(request.shift, REQUESTED_SHIFT);
  EXPECT_EQ(request.negative_prompt, NEGATIVE_PROMPT);
}

TEST(MossSoundEffectRequest, SeedComesFromTheConfig) {
  auto cfg = stubConfig();
  cfg.seed = CONFIGURED_SEED;
  EXPECT_EQ(
      MossSoundEffectModel::toRequest(cfg, promptOnly()).seed,
      static_cast<uint32_t>(CONFIGURED_SEED));
}

TEST(MossSoundEffectModelTest, ReportsTheNativeSampleRate) {
  MossSoundEffectModel model{stubConfig()};
  EXPECT_EQ(model.sampleRate(), MOSS_SFX_NATIVE_SAMPLE_RATE);
}

TEST(MossSoundEffectModelTest, NotLoadedUntilActivated) {
  MossSoundEffectModel model{stubConfig()};
  EXPECT_FALSE(model.isLoaded());
}

TEST(MossSoundEffectModelTest, InvalidGgufFailsToLoadWithoutCrashing) {
  MossSoundEffectModel model{stubConfig()};
  EXPECT_ANY_THROW(model.load());
  EXPECT_FALSE(model.isLoaded());
}

TEST(MossSoundEffectModelTest, ProcessBeforeLoadThrows) {
  MossSoundEffectModel model{stubConfig()};
  EXPECT_ANY_THROW(model.process(std::any(promptOnly())));
}

TEST(MossSoundEffectModelTest, ProcessRejectsForeignInput) {
  MossSoundEffectModel model{stubConfig()};
  EXPECT_THROW(model.process(std::any(std::string(PROMPT))), StatusError);
}

TEST(MossSoundEffectModelTest, RuntimeStatsCarryTheSharedKeys) {
  MossSoundEffectModel model{stubConfig()};
  for (const char* key :
       {"totalTime",
        "realTimeFactor",
        "audioDurationMs",
        "totalSamples",
        "backendDevice",
        "backendId",
        "gpuUnsupported"}) {
    EXPECT_TRUE(statPresent(model, key)) << key;
  }
}

TEST(MossSoundEffectReload, InvalidConfigKeepsThePreviousOne) {
  MossSoundEffectModel model{stubConfig()};
  const std::string previous = model.config().modelPath;
  MossSoundEffectConfig broken;
  EXPECT_THROW(model.reloadWith(broken), StatusError);
  EXPECT_EQ(model.config().modelPath, previous);
}

TEST(MossSoundEffectRealGguf, GeneratesTheRequestedDuration) {
  const std::string modelPath = envOrEmpty(MOSS_SFX_ENV);
  if (modelPath.empty()) {
    GTEST_SKIP() << "set QVAC_TEST_MOSS_SFX_GGUF to run this";
  }
  MossSoundEffectConfig cfg;
  cfg.modelPath = modelPath;
  cfg.seed = CONFIGURED_SEED;
  if (!envOrEmpty(MOSS_SFX_GPU_ENV).empty())
    cfg.useGpu = true;
  MossSoundEffectModel model{cfg};
  ASSERT_NO_THROW(model.load());

  auto input = promptOnly();
  input.call.seconds = REAL_GGUF_SECONDS;
  input.call.steps = REAL_GGUF_STEPS;
  const auto pcm = std::any_cast<MossSoundEffectModel::Output>(
      model.process(std::any(input)));
  EXPECT_EQ(
      pcm.size(),
      static_cast<size_t>(REAL_GGUF_SECONDS * MOSS_SFX_NATIVE_SAMPLE_RATE));
}
