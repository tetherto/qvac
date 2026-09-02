#include <any>
#include <cstdint>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "handlers/WorldSessionHandlers.hpp"
#include "model-interface/WorldSessionModel.hpp"

using namespace qvac_lib_inference_addon_sd;
using qvac_errors::StatusError;

// ABot-World session model: the pre-engine validation surface. Everything
// here must fail (or succeed) before any model file or GPU backend is
// touched, so these tests run with no models present — same level as
// test_sd_model.cpp.

class WorldSessionModelTest : public ::testing::Test {};

TEST_F(WorldSessionModelTest, ConstructWithEmptyConfigDoesNotThrow) {
  WorldSessionConfig config{};
  EXPECT_NO_THROW(WorldSessionModel model(std::move(config)));
}

TEST_F(WorldSessionModelTest, IsNotLoadedAfterConstruction) {
  WorldSessionModel model(WorldSessionConfig{});
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(WorldSessionModelTest, GetNameReturnsWorldSessionModel) {
  WorldSessionModel model(WorldSessionConfig{});
  EXPECT_EQ(model.getName(), "WorldSessionModel");
}

TEST_F(WorldSessionModelTest, ConfigDefaultsMatchDocumentedContract) {
  // world.js/world.d.ts and docs/abot-world.md document these defaults;
  // drift here silently changes every session created without overrides.
  WorldSessionConfig config{};
  EXPECT_EQ(config.nThreads, -1);
  EXPECT_EQ(config.seed, 42);
  EXPECT_EQ(config.numFramePerBlock, 0); // 0 = model default (3)
  EXPECT_EQ(config.localAttnSize, 0);    // 0 = engine default (8)
  EXPECT_EQ(config.frameJpegQuality, 0); // 0 = PNG frames
  EXPECT_FALSE(config.offloadParamsToCpu);
  EXPECT_FALSE(config.kvCache);
  EXPECT_FALSE(config.profile);
}

TEST_F(WorldSessionModelTest, LoadWithoutPathsThrowsInvalidArgument) {
  // Path validation runs before any backend module is loaded.
  WorldSessionModel model(WorldSessionConfig{});
  EXPECT_THROW(model.load(), StatusError);
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(WorldSessionModelTest, LoadWithPartialPathsThrowsInvalidArgument) {
  WorldSessionConfig config{};
  config.ditModelPath = "/nonexistent/dit.gguf";
  config.taehvPath = "/nonexistent/taehv.gguf";
  // scenePath left empty on purpose
  WorldSessionModel model(std::move(config));
  EXPECT_THROW(model.load(), StatusError);
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(WorldSessionModelTest, ActionFlagBitsMatchTheDocumentedKeyOrder) {
  // The JS side builds masks from KEY_ORDER = [W,A,S,D,I,J,K,L] (bit 0..7);
  // the JS ActionFlag export mirrors these values. Pin the native enum so
  // the three can never drift apart silently.
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::None), 0U);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::W), 1U << 0);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::A), 1U << 1);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::S), 1U << 2);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::D), 1U << 3);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::I), 1U << 4);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::J), 1U << 5);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::K), 1U << 6);
  EXPECT_EQ(static_cast<uint32_t>(ActionFlag::L), 1U << 7);
}

TEST_F(WorldSessionModelTest, WalkStepBeforeLoadThrows) {
  WorldSessionModel model(WorldSessionConfig{});
  WorldSessionModel::WalkStepJob job;
  job.actionMask = static_cast<uint32_t>(ActionFlag::W);
  EXPECT_THROW(model.process(std::any(job)), StatusError);
}

TEST_F(WorldSessionModelTest, SceneCreateRejectsUndecodableImageBytes) {
  // Scene creation is standalone (no load() needed); the image decode
  // guard fires before encoder paths or backends are touched.
  WorldSessionModel model(WorldSessionConfig{});
  WorldSessionModel::SceneCreateJob job;
  job.prompt = "| unknown |";
  job.imageBytes = {0x00, 0x01, 0x02, 0x03}; // neither PNG nor JPEG magic
  job.t5Path = "/nonexistent/umt5.gguf";
  job.vaePath = "/nonexistent/vae.gguf";
  job.outputPath = "/nonexistent/scene.safetensors";
  EXPECT_THROW(model.process(std::any(job)), StatusError);
}

TEST_F(WorldSessionModelTest, CancelOnFreshModelIsSafe) {
  WorldSessionModel model(WorldSessionConfig{});
  EXPECT_NO_THROW(model.cancel());
}

TEST_F(WorldSessionModelTest, RuntimeStatsEmptyBeforeAnyJob) {
  WorldSessionModel model(WorldSessionConfig{});
  EXPECT_TRUE(model.runtimeStats().empty());
}

TEST_F(WorldSessionModelTest, DestroyUnloadedModelIsNoop) {
  EXPECT_NO_THROW({ WorldSessionModel model(WorldSessionConfig{}); });
}

// -- Config handler map (applyWorldSessionHandlers) ---------------------------
// The JS layer stringifies every config value, so the native handlers must
// accept the same lexical forms as SD_CTX_HANDLERS. The regression that
// motivated this map: `kvCache: 1` arrived as "1", failed a literal
// `v == "true"` comparison, and silently kept the false default.

class WorldSessionHandlersTest : public ::testing::Test {};

TEST_F(WorldSessionHandlersTest, NumericBooleansParse) {
  WorldSessionConfig config{};
  applyWorldSessionHandlers(
      config,
      {{"kvCache", "1"}, {"offloadParamsToCpu", "1"}, {"profile", "1"}});
  EXPECT_TRUE(config.kvCache);
  EXPECT_TRUE(config.offloadParamsToCpu);
  EXPECT_TRUE(config.profile);

  applyWorldSessionHandlers(
      config, {{"kvCache", "0"}, {"offloadParamsToCpu", "false"}});
  EXPECT_FALSE(config.kvCache);
  EXPECT_FALSE(config.offloadParamsToCpu);
  EXPECT_TRUE(config.profile); // untouched keys keep their values
}

TEST_F(WorldSessionHandlersTest, InvalidBooleanThrowsTyped) {
  WorldSessionConfig config{};
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"kvCache", "yes"}}), StatusError);
}

TEST_F(WorldSessionHandlersTest, ThreadsMatchesSiblingSemantics) {
  WorldSessionConfig config{};
  applyWorldSessionHandlers(config, {{"threads", "8"}});
  EXPECT_EQ(config.nThreads, 8);
  applyWorldSessionHandlers(config, {{"threads", "-1"}});
  EXPECT_EQ(config.nThreads, -1);
  // 0 and non-numeric throw typed errors, exactly like StableDiffusion.
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"threads", "0"}}), StatusError);
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"threads", "auto"}}), StatusError);
}

TEST_F(WorldSessionHandlersTest, JpegQualityRangeChecked) {
  WorldSessionConfig config{};
  applyWorldSessionHandlers(config, {{"frameJpegQuality", "85"}});
  EXPECT_EQ(config.frameJpegQuality, 85);
  applyWorldSessionHandlers(config, {{"frameJpegQuality", "0"}});
  EXPECT_EQ(config.frameJpegQuality, 0);
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"frameJpegQuality", "101"}}),
      StatusError);
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"frameJpegQuality", "-1"}}),
      StatusError);
}

TEST_F(WorldSessionHandlersTest, BlockShapeKnobsRejectNegatives) {
  WorldSessionConfig config{};
  applyWorldSessionHandlers(
      config, {{"numFramePerBlock", "3"}, {"localAttnSize", "8"}});
  EXPECT_EQ(config.numFramePerBlock, 3);
  EXPECT_EQ(config.localAttnSize, 8);
  applyWorldSessionHandlers(config, {{"numFramePerBlock", "0"}});
  EXPECT_EQ(config.numFramePerBlock, 0); // 0 = model default
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"localAttnSize", "-8"}}),
      StatusError);
}

TEST_F(WorldSessionHandlersTest, SeedAndStringsAndUnknownKeys) {
  WorldSessionConfig config{};
  applyWorldSessionHandlers(
      config,
      {{"seed", "1234567890123"},
       {"backend", "cuda0"},
       {"backendsDir", "/opt/backends"},
       {"someFutureKey", "whatever"}}); // unknown keys silently ignored
  EXPECT_EQ(config.seed, 1234567890123LL);
  EXPECT_EQ(config.backend, "cuda0");
  EXPECT_EQ(config.backendsDir, "/opt/backends");
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"seed", "not-a-number"}}),
      StatusError);
}
