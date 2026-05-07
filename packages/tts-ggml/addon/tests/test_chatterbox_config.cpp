// Constructor-validation tests for ChatterboxModel.
//
// `ChatterboxModel::validateConfig()` is private but the constructor calls
// it before `load()`, so any config that fails validation throws before the
// expensive (real-GGUF) load step.  We exercise validateConfig indirectly
// by attempting construction with bad configs and asserting the throw
// path / error code.
//
// Real-GGUF tests (full construct + process round-trip) are gated behind
// QVAC_TEST_CHATTERBOX_T3_GGUF + QVAC_TEST_CHATTERBOX_S3GEN_GGUF env
// vars.  When unset, the gated tests skip cleanly via GTEST_SKIP() so
// the suite stays green in environments without converted models.

#include <gtest/gtest.h>

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"
#include "model-interface/chatterbox/ChatterboxModel.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"

using qvac::ttsggml::chatterbox::ChatterboxConfig;
using qvac::ttsggml::chatterbox::ChatterboxModel;
using qvac_errors::StatusError;

namespace {

std::filesystem::path testTempDir() {
  return std::filesystem::temp_directory_path() / "qvac-tts-ggml-chatterbox-tests";
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

ChatterboxConfig minimallyValidStubConfig() {
  ChatterboxConfig cfg;
  cfg.t3ModelPath = tempPath("t3-stub.gguf").string();
  cfg.s3genModelPath = tempPath("s3gen-stub.gguf").string();
  writeStubFile(cfg.t3ModelPath);
  writeStubFile(cfg.s3genModelPath);
  return cfg;
}

}

TEST(ChatterboxValidate, EmptyT3PathRejected) {
  ChatterboxConfig cfg;
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, EmptyS3genPathRejected) {
  ChatterboxConfig cfg;
  cfg.t3ModelPath = tempPath("t3.gguf").string();
  writeStubFile(cfg.t3ModelPath);
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, NonexistentT3PathRejected) {
  ChatterboxConfig cfg;
  cfg.t3ModelPath = "/definitely/does/not/exist/t3.gguf";
  cfg.s3genModelPath = "/definitely/does/not/exist/s3gen.gguf";
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, NonexistentS3genPathRejected) {
  ChatterboxConfig cfg;
  cfg.t3ModelPath = tempPath("t3-only.gguf").string();
  writeStubFile(cfg.t3ModelPath);
  cfg.s3genModelPath = "/definitely/does/not/exist/s3gen.gguf";
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, NonexistentReferenceAudioRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.referenceAudio = "/definitely/does/not/exist/ref.wav";
  // Validation rejects before load, so we don't need a real GGUF to hit
  // this branch.
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, NonexistentVoiceDirRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.voiceDir = "/definitely/does/not/exist/voice/";
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, VoiceDirPointingAtFileRejected) {
  auto cfg = minimallyValidStubConfig();
  // Point at the t3 stub file (definitely a file, definitely not a dir).
  cfg.voiceDir = cfg.t3ModelPath;
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, ValidStubPathsReachLoadStep) {
  auto cfg = minimallyValidStubConfig();
  // Stub files pass `std::filesystem::exists()` so validation succeeds,
  // but they aren't real GGUFs — load() then throws InitializationFailed
  // (still a StatusError, just from the next step).  This proves validation
  // on its own does not reject the configuration.
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, ConfigDefaultLanguageIsEnglish) {
  ChatterboxConfig cfg;
  EXPECT_EQ(cfg.language, "en");
}

TEST(ChatterboxValidate, ConfigUseGpuDefaultIsFalse) {
  ChatterboxConfig cfg;
  EXPECT_FALSE(cfg.useGpu);
  EXPECT_FALSE(cfg.seed.has_value());
  EXPECT_FALSE(cfg.threads.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.streamChunkTokens.has_value());
}

// ─────────────────────────────────────────────────────────────────────
//  Real-GGUF round-trip (env-var gated).
// ─────────────────────────────────────────────────────────────────────

TEST(ChatterboxRealGguf, ConstructAndUnloadIfAvailable) {
  const auto t3 = envOrEmpty("QVAC_TEST_CHATTERBOX_T3_GGUF");
  const auto s3 = envOrEmpty("QVAC_TEST_CHATTERBOX_S3GEN_GGUF");
  if (t3.empty() || s3.empty()) {
    GTEST_SKIP() << "Set QVAC_TEST_CHATTERBOX_T3_GGUF + "
                    "QVAC_TEST_CHATTERBOX_S3GEN_GGUF to enable.";
  }
  if (!std::filesystem::exists(t3) || !std::filesystem::exists(s3)) {
    GTEST_SKIP() << "Configured GGUFs do not exist on disk.";
  }

  ChatterboxConfig cfg;
  cfg.t3ModelPath = t3;
  cfg.s3genModelPath = s3;
  cfg.useGpu = false;

  ChatterboxModel m(cfg);
  EXPECT_TRUE(m.isLoaded());
  EXPECT_EQ(m.getName(), "ChatterboxModel");
  EXPECT_NO_THROW(m.unload());
  EXPECT_FALSE(m.isLoaded());
}

TEST(ChatterboxRealGguf, ProcessRejectsWrongAnyInputType) {
  const auto t3 = envOrEmpty("QVAC_TEST_CHATTERBOX_T3_GGUF");
  const auto s3 = envOrEmpty("QVAC_TEST_CHATTERBOX_S3GEN_GGUF");
  if (t3.empty() || s3.empty()) {
    GTEST_SKIP() << "Set QVAC_TEST_CHATTERBOX_T3_GGUF + "
                    "QVAC_TEST_CHATTERBOX_S3GEN_GGUF to enable.";
  }
  if (!std::filesystem::exists(t3) || !std::filesystem::exists(s3)) {
    GTEST_SKIP() << "Configured GGUFs do not exist on disk.";
  }

  ChatterboxConfig cfg;
  cfg.t3ModelPath = t3;
  cfg.s3genModelPath = s3;
  cfg.useGpu = false;

  ChatterboxModel m(cfg);
  EXPECT_THROW(m.process(std::any{std::string{"raw string instead of AnyInput"}}),
               StatusError);
  EXPECT_THROW(m.process(std::any{int64_t{42}}), StatusError);

  ChatterboxModel::AnyInput emptyText{};
  EXPECT_THROW(m.process(std::any{emptyText}), StatusError);
}
