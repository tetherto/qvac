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

TEST(ChatterboxValidate, SpeedBelowRangeRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.speed = 0.1f;
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, SpeedAboveRangeRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.speed = 8.0f;
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, SpeedZeroRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.speed = 0.0f;
  EXPECT_THROW(ChatterboxModel{cfg}, StatusError);
}

TEST(ChatterboxValidate, ValidSpeedAccepted) {
  auto cfg = minimallyValidStubConfig();
  cfg.speed = 0.8f; // a typical "slow it down" value
  // Stub files pass validation; load is deferred, so construction succeeds.
  std::unique_ptr<ChatterboxModel> m;
  EXPECT_NO_THROW(m = std::make_unique<ChatterboxModel>(cfg));
  EXPECT_NE(m, nullptr);
}

TEST(ChatterboxValidate, ConfigSpeedDefaultUnset) {
  // Unset speed means "no rate change" (1.0) at synthesis time — the addon
  // applies no per-language default, preserving raw-model backward compat.
  ChatterboxConfig cfg;
  EXPECT_FALSE(cfg.speed.has_value());
}

// ─────────────────────────────────────────────────────────────────────
//  ChatterboxConfig -> tts_cpp EngineOptions mapping.
// ─────────────────────────────────────────────────────────────────────

// The T3 KV cache is allocated up-front at n_ctx (Turbo GGUF ships
// n_ctx=8196 ~= 1.6 GB of f32 KV), so the addon must cap it by default
// rather than inherit tts-cpp's uncapped library default (QVAC-19557 iOS
// OOM).  4096 + the f16 dtype default below ~= 390 MB.
TEST(ChatterboxEngineOptions, NCtxDefaultsTo4096) {
  ChatterboxConfig cfg;
  const auto opts = qvac::ttsggml::chatterbox::engineOptionsForTests(cfg);
  EXPECT_EQ(opts.n_ctx, 4096);
}

// f16 KV by default: ~50% of f32's resident KV memory and the safe
// cross-backend default.  q8_0 (~27%, the prior 0.3.2 default) aborts the
// multilingual model on Metal because the ggml-speech Metal backend has no
// q8_0->q8_0 CONT, so it is opt-in rather than the default.
TEST(ChatterboxEngineOptions, KvCacheTypeDefaultsToF16) {
  ChatterboxConfig cfg;
  EXPECT_EQ(
      qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).kv_cache_type,
      "f16");
}

// Tripwire (QVAC-21401): the *default* KV-cache dtype must be one every GPU
// backend can run the full multilingual T3 step graph with.  The MTL graph
// (tts-cpp eval_step_mtl) issues a ggml_cont on the KV cache, and ggml-speech's
// Metal backend has no q8_0->q8_0 CONT, so a *quantized* default (q8_0, the
// 0.3.2 QVAC-19557 default) hard-aborts the multilingual model on Metal with
// GGML_ABORT("unsupported op 'CONT'").  This asserts the *property* (default is
// f32/f16, never quantized), not just the current literal — so a future
// re-flip to a quantized default trips this cheap, no-GPU PR check instead of
// shipping and aborting on a user's Apple Silicon device.  Relax deliberately
// only once tts-cpp's chatterbox_resolve_kv_type probes CONT (and auto-
// downgrades quantized KV on backends that can't run it).
TEST(ChatterboxEngineOptions, DefaultKvCacheTypeIsGpuSafeNotQuantized) {
  ChatterboxConfig cfg;  // no kvCacheType -> addon default
  const std::string def =
      qvac::ttsggml::chatterbox::engineOptionsForTests(cfg).kv_cache_type;
  EXPECT_TRUE(def == "f32" || def == "f16")
      << "default KV-cache dtype '" << def << "' is not GPU-safe: a quantized "
         "default aborts the multilingual Chatterbox model on Metal "
         "(unsupported q8_0 CONT, QVAC-21401). Keep the default f16/f32, or "
         "land the tts-cpp CONT-probe fix before re-quantizing it.";
  EXPECT_NE(def, "q8_0");
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
