// runtimeStats() surface of every engine and the LavaSR denoiser loader.
//
// Constructing a model validates its config without loading weights, so the
// stats here are the "nothing synthesized / nothing loaded" defaults: each
// public field must be present, carry the type the JS layer expects, and hold
// its sentinel. The loaded-denoiser case needs a real GGUF and is gated behind
// QVAC_TEST_LAVASR_DENOISER_GGUF.

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <variant>

#include <gtest/gtest.h>

#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/DenoiserLoader.hpp"
#include "model-interface/audio8/Audio8Model.hpp"
#include "model-interface/chatterbox/ChatterboxModel.hpp"
#include "model-interface/cosyvoice/CosyvoiceModel.hpp"
#include "model-interface/parler/ParlerModel.hpp"
#include "model-interface/supertonic/SupertonicModel.hpp"

using qvac::ttsggml::denoiserBackendIdFromName;
using qvac::ttsggml::kBackendDeviceCpu;
using qvac::ttsggml::kBackendDeviceGpu;
using qvac::ttsggml::loadDenoiser;
using qvac_errors::StatusError;
using Stats = qvac_lib_inference_addon_cpp::RuntimeStats;
using StatValue = std::variant<double, int64_t>;

namespace {

std::filesystem::path stageDir() {
  auto dir = std::filesystem::temp_directory_path() /
             "qvac-tts-ggml-runtime-stats-tests";
  std::filesystem::create_directories(dir);
  return dir;
}

std::string stub(const std::string& name) {
  const auto path = stageDir() / name;
  std::ofstream(path, std::ios::binary) << "stub";
  return path.string();
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

std::optional<StatValue> statOf(const Stats& stats, const std::string& name) {
  for (const auto& [key, value] : stats) {
    if (key == name)
      return value;
  }
  return std::nullopt;
}

void expectIntStat(const Stats& stats, const std::string& name, int64_t want) {
  const auto value = statOf(stats, name);
  ASSERT_TRUE(value.has_value()) << name << " is missing from runtimeStats()";
  ASSERT_TRUE(std::holds_alternative<int64_t>(*value))
      << name << " must be an integer stat";
  EXPECT_EQ(std::get<int64_t>(*value), want) << name;
}

void expectDoubleStat(
    const Stats& stats, const std::string& name, double want) {
  const auto value = statOf(stats, name);
  ASSERT_TRUE(value.has_value()) << name << " is missing from runtimeStats()";
  ASSERT_TRUE(std::holds_alternative<double>(*value))
      << name << " must be a floating-point stat";
  EXPECT_DOUBLE_EQ(std::get<double>(*value), want) << name;
}

void expectDenoiserNotLoaded(const Stats& stats) {
  expectIntStat(stats, "denoiserBackendDevice", -1);
  expectIntStat(stats, "denoiserBackendId", -1);
}

} // namespace

TEST(RuntimeStats, ChatterboxReportsStageStatsAndDenoiserSentinels) {
  qvac::ttsggml::chatterbox::ChatterboxConfig cfg;
  cfg.t3ModelPath = stub("t3-stub.gguf");
  cfg.s3genModelPath = stub("s3gen-stub.gguf");
  const qvac::ttsggml::chatterbox::ChatterboxModel model(cfg);
  const Stats stats = model.runtimeStats();
  expectDoubleStat(stats, "t3Ms", 0.0);
  expectDoubleStat(stats, "s3genMs", 0.0);
  expectIntStat(stats, "t3Tokens", 0);
  expectDenoiserNotLoaded(stats);
}

TEST(RuntimeStats, SupertonicReportsDenoiserSentinels) {
  qvac::ttsggml::supertonic::SupertonicConfig cfg;
  cfg.modelGgufPath = stub("supertonic-stub.gguf");
  const qvac::ttsggml::supertonic::SupertonicModel model(cfg);
  expectDenoiserNotLoaded(model.runtimeStats());
}

TEST(RuntimeStats, ParlerReportsDenoiserSentinels) {
  qvac::ttsggml::parler::ParlerConfig cfg;
  cfg.modelGgufPath = stub("parler-stub.gguf");
  const qvac::ttsggml::parler::ParlerModel model(cfg);
  expectDenoiserNotLoaded(model.runtimeStats());
}

TEST(RuntimeStats, CosyvoiceReportsStageTimingsAndDenoiserSentinels) {
  qvac::ttsggml::cosyvoice::CosyvoiceConfig cfg;
  cfg.modelDir = stageDir().string();
  const qvac::ttsggml::cosyvoice::CosyvoiceModel model(cfg);
  const Stats stats = model.runtimeStats();
  for (const char* name :
       {"lmPrefillMs",
        "lmDecodeMs",
        "flowFrontendMs",
        "ditEulerMs",
        "hiftF0Ms",
        "hiftSourceMs",
        "hiftStftMs",
        "hiftDecodeMs",
        "stageTotalMs"}) {
    expectDoubleStat(stats, name, 0.0);
  }
  for (const char* name :
       {"decodeSteps",
        "speechTokens",
        "flowFrames",
        "melFrames",
        "textIds",
        "promptSpeechTokens"}) {
    expectIntStat(stats, name, 0);
  }
  expectDenoiserNotLoaded(stats);
}

TEST(RuntimeStats, Audio8ReportsStageTimings) {
  qvac::ttsggml::audio8::Audio8Config cfg;
  cfg.lmModelPath = stub("audio8-lm-stub.gguf");
  cfg.codecDecoderPath = stub("audio8-decoder-stub.gguf");
  const qvac::ttsggml::audio8::Audio8Model model(cfg);
  const Stats stats = model.runtimeStats();
  for (const char* name :
       {"voiceEncodeMs",
        "promptMs",
        "prefillMs",
        "sampleMs",
        "fastDecodeMs",
        "slowDecodeMs",
        "codecLatentMs",
        "codecSynthMs",
        "resampleMs",
        "stageTotalMs"}) {
    expectDoubleStat(stats, name, 0.0);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  LavaSR denoiser loader: disabled, failing and loaded states.
// ─────────────────────────────────────────────────────────────────────

TEST(DenoiserLoader, EmptyPathLeavesTheDenoiserDisabled) {
  for (const bool resolvedGpu : {false, true}) {
    const auto loaded = loadDenoiser("", resolvedGpu, "test: ");
    EXPECT_EQ(loaded.denoiser, nullptr);
    EXPECT_EQ(loaded.backendDevice, -1);
    EXPECT_EQ(loaded.backendId, -1);
  }
}

TEST(DenoiserLoader, UnreadableGgufThrows) {
  EXPECT_THROW(
      loadDenoiser(stub("not-a-denoiser.gguf"), false, "test: "), StatusError);
}

// "scalar" is the denoiser's pure-CPU core; the ggml names map as for the
// engines' backendId.
TEST(DenoiserLoader, BackendNamesMapToBackendIds) {
  EXPECT_EQ(denoiserBackendIdFromName("scalar"), 0);
  EXPECT_EQ(denoiserBackendIdFromName("CPU"), 0);
  EXPECT_EQ(denoiserBackendIdFromName("Metal"), 1);
  EXPECT_EQ(denoiserBackendIdFromName("CUDA0"), 2);
  EXPECT_EQ(denoiserBackendIdFromName("Vulkan0"), 3);
  EXPECT_EQ(denoiserBackendIdFromName("OpenCL"), 4);
}

TEST(DenoiserLoader, LoadedDenoiserReportsWhereItRunsIfAvailable) {
  const std::string path = envOrEmpty("QVAC_TEST_LAVASR_DENOISER_GGUF");
  if (path.empty()) {
    GTEST_SKIP() << "QVAC_TEST_LAVASR_DENOISER_GGUF not set";
  }

  const auto cpu = loadDenoiser(path, false, "test: ");
  ASSERT_NE(cpu.denoiser, nullptr);
  EXPECT_EQ(cpu.backendDevice, kBackendDeviceCpu)
      << "CPU engine -> scalar core";
  EXPECT_EQ(cpu.backendId, 0);

  // A GPU engine asks for the ggml GPU graph; tts-cpp falls back to the ggml
  // CPU backend when no GPU backend initialises, and the codes follow suit.
  const auto gpu = loadDenoiser(path, true, "test: ");
  ASSERT_NE(gpu.denoiser, nullptr);
  if (gpu.backendDevice == kBackendDeviceGpu) {
    EXPECT_NE(gpu.backendId, 0);
  } else {
    EXPECT_EQ(gpu.backendDevice, kBackendDeviceCpu);
    EXPECT_EQ(gpu.backendId, 0);
  }
}
