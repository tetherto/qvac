#include <any>
#include <cstdint>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

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

TEST_F(WorldSessionModelTest, WalkStepBeforeLoadThrows) {
  WorldSessionModel model(WorldSessionConfig{});
  WorldSessionModel::WalkStepJob job;
  job.actionMask = 0b00000001; // W held
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
