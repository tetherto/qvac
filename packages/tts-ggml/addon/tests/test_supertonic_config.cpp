// Constructor-validation tests for SupertonicModel.  Same shape as
// test_chatterbox_config.cpp: validateConfig is private so we drive it
// indirectly via the public constructor and assert the throw path.
//
// Real-GGUF round-trip is gated behind QVAC_TEST_SUPERTONIC_GGUF.

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#include "model-interface/supertonic/SupertonicConfig.hpp"
#include "model-interface/supertonic/SupertonicModel.hpp"
#include "inference-addon-cpp/Errors.hpp"

using qvac::ttsggml::supertonic::SupertonicConfig;
using qvac::ttsggml::supertonic::SupertonicModel;
using qvac_errors::StatusError;

namespace {

std::filesystem::path testTempDir() {
  return std::filesystem::temp_directory_path() / "qvac-tts-ggml-supertonic-tests";
}

std::filesystem::path tempPath(const std::string& suffix) {
  auto dir = testTempDir();
  std::filesystem::create_directories(dir);
  return dir / suffix;
}

void writeStubFile(const std::filesystem::path& p,
                   const std::string& contents = "stub") {
  std::ofstream(p, std::ios::binary) << contents;
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name)) return v;
  return "";
}

SupertonicConfig minimallyValidStubConfig() {
  SupertonicConfig cfg;
  cfg.modelGgufPath = tempPath("supertonic-stub.gguf").string();
  writeStubFile(cfg.modelGgufPath);
  return cfg;
}

}

TEST(SupertonicValidate, EmptyModelPathRejected) {
  SupertonicConfig cfg;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NonexistentModelPathRejected) {
  SupertonicConfig cfg;
  cfg.modelGgufPath = "/definitely/does/not/exist/supertonic.gguf";
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NegativeStepsRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.steps = -1;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NegativeSpeedRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.speed = -0.5f;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NonexistentNoiseNpyRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.noiseNpyPath = "/definitely/does/not/exist/noise.npy";
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, UseGpuTrueAcceptedAtConstruction) {
  // GPU intent is now honored for Supertonic on GPU-capable hosts (Metal on
  // Apple, Vulkan/CUDA on desktop); Android is forced back to CPU at load
  // (loadLocked). Construction must NOT reject useGpu=true -- the GGUF parse
  // is deferred to load(), so a bare stub config validates cleanly.
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  EXPECT_NO_THROW(SupertonicModel{cfg});
}

TEST(SupertonicValidate, NGpuLayersGreaterThanZeroAccepted) {
  auto cfg = minimallyValidStubConfig();
  cfg.nGpuLayers = 99;
  EXPECT_NO_THROW(SupertonicModel{cfg});
}

TEST(SupertonicValidate, UseGpuNGpuLayersConflictStillRejected) {
  // The cross-field conflict check is preserved: useGPU=true paired with
  // nGpuLayers=0 (or useGPU=false with nGpuLayers!=0) is contradictory and
  // must still throw so callers can't silently get the opposite backend.
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  cfg.nGpuLayers = 0;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NGpuLayersZeroAcceptedAndDeferredLoad) {
  auto cfg = minimallyValidStubConfig();
  cfg.nGpuLayers = 0;
  // Validation passes (CPU-only path); the stub file then fails GGUF
  // parsing on load() (not at construction — load is now deferred to
  // waitForLoadInitialization).  The eventual throw must NOT be the
  // GPU-rejection branch.
  std::unique_ptr<SupertonicModel> m;
  EXPECT_NO_THROW(m = std::make_unique<SupertonicModel>(cfg));
  ASSERT_NE(m, nullptr);
  EXPECT_FALSE(m->isLoaded());
  bool threw = false;
  try {
    m->load();
  } catch (const StatusError& e) {
    threw = true;
    const std::string what = e.what();
    EXPECT_EQ(what.find("GPU"), std::string::npos)
        << "nGpuLayers=0 should not trigger the GPU-rejection path; got: " << what;
  }
  EXPECT_TRUE(threw);
  EXPECT_FALSE(m->isLoaded());
}

TEST(SupertonicValidate, WaitForLoadInitializationDelegatesToLoad) {
  auto cfg = minimallyValidStubConfig();
  SupertonicModel m(cfg);
  EXPECT_FALSE(m.isLoaded());
  EXPECT_THROW(m.waitForLoadInitialization(), StatusError);
}

TEST(SupertonicValidate, ConfigDefaultsAreCpuFriendly) {
  SupertonicConfig cfg;
  EXPECT_EQ(cfg.language, "en");
  EXPECT_FALSE(cfg.useGpu.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.steps.has_value());
  EXPECT_FALSE(cfg.speed.has_value());
}

// ─────────────────────────────────────────────────────────────────────
//  Real-GGUF round-trip (env-var gated).
// ─────────────────────────────────────────────────────────────────────

TEST(SupertonicRealGguf, ConstructAndUnloadIfAvailable) {
  const auto path = envOrEmpty("QVAC_TEST_SUPERTONIC_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_SUPERTONIC_GGUF to enable.";
  }

  SupertonicConfig cfg;
  cfg.modelGgufPath = path;
  cfg.useGpu = false;
  cfg.voice = "F1";

  SupertonicModel m(cfg);
  EXPECT_FALSE(m.isLoaded()) << "load is now deferred until activate()/load()";
  EXPECT_EQ(m.getName(), "SupertonicModel");
  EXPECT_NO_THROW(m.load());
  EXPECT_TRUE(m.isLoaded());
  EXPECT_GT(m.sampleRate(), 0);
  EXPECT_NO_THROW(m.unload());
  EXPECT_FALSE(m.isLoaded());
}

TEST(SupertonicRealGguf, ProcessRejectsWrongAnyInputType) {
  const auto path = envOrEmpty("QVAC_TEST_SUPERTONIC_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_SUPERTONIC_GGUF to enable.";
  }

  SupertonicConfig cfg;
  cfg.modelGgufPath = path;
  cfg.useGpu = false;

  SupertonicModel m(cfg);
  m.load();  // load is deferred since the constructor refactor; trigger it here
  // Wrong AnyInput type is the only well-defined invariant SupertonicModel
  // checks at the boundary; empty-text behaviour is delegated to the
  // underlying tts_cpp::supertonic::Engine and intentionally left
  // untested here to avoid coupling to engine-internal policy.
  EXPECT_THROW(m.process(std::any{int64_t{42}}), StatusError);
}
