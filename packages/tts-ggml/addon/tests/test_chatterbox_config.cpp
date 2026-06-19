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

#include <tts-cpp/chatterbox/engine.h>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"
#include "model-interface/chatterbox/ChatterboxModel.hpp"
#include "inference-addon-cpp/Errors.hpp"

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

TEST(ChatterboxValidate, ValidStubPathsConstructAndDeferLoad) {
  auto cfg = minimallyValidStubConfig();
  // Stub files pass `std::filesystem::exists()` so validation succeeds.
  // Construction now defers GGUF parsing to waitForLoadInitialization()
  // (called by AddonCpp::activate() on a JsAsyncTask worker thread), so
  // the stub-file InitializationFailed throw happens on load(), not in
  // the constructor.  This proves validation passes AND that load is
  // truly deferred (otherwise this would still throw at construction).
  std::unique_ptr<ChatterboxModel> m;
  EXPECT_NO_THROW(m = std::make_unique<ChatterboxModel>(cfg));
  ASSERT_NE(m, nullptr);
  EXPECT_FALSE(m->isLoaded());
  EXPECT_THROW(m->load(), StatusError);
  EXPECT_FALSE(m->isLoaded());
}

TEST(ChatterboxValidate, WaitForLoadInitializationDelegatesToLoad) {
  auto cfg = minimallyValidStubConfig();
  ChatterboxModel m(cfg);
  EXPECT_FALSE(m.isLoaded());
  // waitForLoadInitialization() is the IModelAsyncLoad entry point
  // AddonCpp::activate() ultimately calls; it should propagate the same
  // load-failure as load() itself.
  EXPECT_THROW(m.waitForLoadInitialization(), StatusError);
}

TEST(ChatterboxValidate, ConfigDefaultLanguageIsEnglish) {
  ChatterboxConfig cfg;
  EXPECT_EQ(cfg.language, "en");
}

TEST(ChatterboxValidate, ConfigUseGpuDefaultIsFalse) {
  ChatterboxConfig cfg;
  EXPECT_FALSE(cfg.useGpu.has_value());
  EXPECT_FALSE(cfg.seed.has_value());
  EXPECT_FALSE(cfg.threads.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.streamChunkTokens.has_value());
  EXPECT_FALSE(cfg.nCtx.has_value());
}

TEST(ChatterboxValidate, NegativeNCtxRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.nCtx = -1;
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

// ─────────────────────────────────────────────────────────────────────
//  ChatterboxConfig -> tts_cpp EngineOptions mapping.
// ─────────────────────────────────────────────────────────────────────

// The T3 KV cache is allocated up-front at n_ctx (Turbo GGUF ships
// n_ctx=8196 ~= 1.6 GB of f32 KV), so the addon must cap it by default
// rather than inherit tts-cpp's uncapped library default (QVAC-19557 iOS
// OOM).  4096 + the q8_0 dtype default below ~= 210 MB.
TEST(ChatterboxEngineOptions, NCtxDefaultsTo4096) {
  ChatterboxConfig cfg;
  const auto opts = qvac::ttsggml::chatterbox::engineOptionsForTests(cfg);
  EXPECT_EQ(opts.n_ctx, 4096);
}

// q8_0 KV by default: ~27% of f32's resident KV memory; Turbo greedy
// decoding validated byte-identical across f32/f16/q8_0 upstream
// (qvac-ext-lib-whisper.cpp#43).
TEST(ChatterboxEngineOptions, KvCacheTypeDefaultsToQ8) {
  ChatterboxConfig cfg;
  EXPECT_EQ(qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).kv_cache_type, "q8_0");
}

TEST(ChatterboxEngineOptions, ExplicitKvCacheTypeForwarded) {
  ChatterboxConfig cfg;
  cfg.kvCacheType = "f32";
  EXPECT_EQ(qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).kv_cache_type, "f32");
  cfg.kvCacheType = "f16";
  EXPECT_EQ(qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).kv_cache_type, "f16");
}

TEST(ChatterboxValidate, UnknownKvCacheTypeRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.kvCacheType = "q4_0";
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxEngineOptions, ExplicitNCtxForwarded) {
  ChatterboxConfig cfg;
  cfg.nCtx = 1024;
  EXPECT_EQ(qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).n_ctx, 1024);
}

TEST(ChatterboxEngineOptions, NCtxZeroMeansUncapped) {
  // 0 is the documented escape hatch: tts-cpp treats n_ctx <= 0 as "use
  // the GGUF's full context".
  ChatterboxConfig cfg;
  cfg.nCtx = 0;
  EXPECT_EQ(qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).n_ctx, 0);
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
  EXPECT_FALSE(m.isLoaded()) << "load is now deferred until activate()/load()";
  EXPECT_EQ(m.getName(), "ChatterboxModel");
  EXPECT_NO_THROW(m.load());
  EXPECT_TRUE(m.isLoaded());
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
  m.load();  // load is deferred since the constructor refactor; trigger it here
  EXPECT_THROW(m.process(std::any{std::string{"raw string instead of AnyInput"}}),
               StatusError);
  EXPECT_THROW(m.process(std::any{int64_t{42}}), StatusError);

  ChatterboxModel::AnyInput emptyText{};
  EXPECT_THROW(m.process(std::any{emptyText}), StatusError);
}
