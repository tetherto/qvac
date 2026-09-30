#include <any>
#include <cstdint>
#include <memory>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "handlers/SdCtxHandlers.hpp"
#include "handlers/WorldSessionHandlers.hpp"
#include "model-interface/WorldSessionModel.hpp"
#include "utils/EsrganUpscaler.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_sd;
using qvac_errors::StatusError;

// ABot-World session model: the pre-engine validation surface. Everything
// here must fail (or succeed) before any model file or GPU backend is
// touched, so these tests run with no models present — same level as
// test_sd_model.cpp.

class WorldSessionModelTest : public ::testing::Test {};

TEST_F(WorldSessionModelTest, StreamingPlacementWarningIsVisibleByDefault) {
  const auto previousVerbosity = logging::g_verbosityLevel.load();
  logging::g_verbosityLevel =
      qvac_lib_inference_addon_cpp::logger::Priority::ERROR;
  testing::internal::CaptureStdout();
  sdLogCallback(
      SD_LOG_WARN,
      "stable-diffusion.cpp:7874 - stream_layers has no effect unless "
      "diffusion params backend is cpu; ignoring\n",
      nullptr);
  const auto output = testing::internal::GetCapturedStdout();
  testing::internal::CaptureStdout();
  sdLogCallback(SD_LOG_WARN, "ordinary warning", nullptr);
  sdLogCallback(SD_LOG_INFO, "ordinary info", nullptr);
  sdLogCallback(SD_LOG_WARN, nullptr, nullptr);
  const auto filtered = testing::internal::GetCapturedStdout();
  logging::g_verbosityLevel = previousVerbosity;
  EXPECT_NE(output.find("[ERROR]"), std::string::npos);
  EXPECT_NE(output.find("diffusion params backend is cpu"), std::string::npos);
  EXPECT_TRUE(filtered.empty());
}

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
  EXPECT_TRUE(config.paramsBackend.empty());
  EXPECT_TRUE(config.maxVram.empty());
  EXPECT_FALSE(config.streamLayers);
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

TEST_F(
    WorldSessionHandlersTest, VerbosityIsValidatedWithoutChangingGlobalState) {
  const auto previous = logging::g_verbosityLevel.load();
  WorldSessionConfig config;
  EXPECT_FALSE(config.verbosity.has_value());
  for (int level = 0; level <= 3; ++level) {
    applyWorldSessionHandlers(config, {{"verbosity", std::to_string(level)}});
    EXPECT_EQ(config.verbosity, level);
    EXPECT_EQ(logging::g_verbosityLevel.load(), previous);
  }
  for (const auto* value : {"9", "-1", "oops", "2.5", "3x", ""}) {
    try {
      applyWorldSessionHandlers(config, {{"verbosity", value}});
      FAIL() << value;
    } catch (const StatusError& error) {
      EXPECT_NE(error.codeString().find("InvalidArgument"), std::string::npos);
      EXPECT_NE(std::string(error.what()).find("verbosity"), std::string::npos);
    }
  }
}

TEST_F(WorldSessionModelTest, VerbosityRestoresAcrossOverlappingSessions) {
  using qvac_lib_inference_addon_cpp::logger::Priority;
  const auto previous = logging::g_verbosityLevel.load();
  WorldSessionConfig config;
  config.verbosity = 3;
  auto first = std::make_unique<WorldSessionModel>(config);
  EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::DEBUG);
  config.verbosity = 1;
  auto second = std::make_unique<WorldSessionModel>(config);
  EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::WARNING);
  first.reset();
  EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::WARNING);
  second.reset();
  EXPECT_EQ(logging::g_verbosityLevel.load(), previous);
  {
    WorldSessionModel outer(config);
    config.verbosity = 3;
    {
      WorldSessionModel inner(config);
      EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::DEBUG);
    }
    EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::WARNING);
  }
  EXPECT_EQ(logging::g_verbosityLevel.load(), previous);
}

TEST_F(WorldSessionModelTest, VerbosityDoesNotOverwriteLaterGlobalSetting) {
  using qvac_lib_inference_addon_cpp::logger::Priority;
  const auto previous = logging::g_verbosityLevel.load();
  {
    WorldSessionConfig config;
    config.verbosity = 3;
    WorldSessionModel world(config);
    std::unordered_map<std::string, std::string> settings{{"verbosity", "2"}};
    logging::setVerbosityLevel(settings);
    WorldSessionModel unconfigured(WorldSessionConfig{});
    EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::INFO);
  }
  EXPECT_EQ(logging::g_verbosityLevel.load(), Priority::INFO);
  logging::g_verbosityLevel = previous;
}

TEST_F(WorldSessionModelTest, InvalidPlacementThrowsTypedBeforeLoadingModels) {
  for (const auto* spec :
       {"vae=disk",
        "disk",
        "default=disk",
        "tae=DISK",
        "vae=cpu,auto_encoder=disk",
        "all=disk,diffusion=cpu"}) {
    WorldSessionConfig config;
    config.paramsBackend = spec;
    WorldSessionModel model(config);
    try {
      model.load();
      FAIL() << spec;
    } catch (const StatusError& error) {
      EXPECT_NE(error.codeString().find("InvalidArgument"), std::string::npos);
      EXPECT_NE(std::string(error.what()).find("vae=disk"), std::string::npos);
    }
  }
  for (const auto* spec :
       {"nan",
        "inf",
        "1junk",
        "cuda0=",
        "=2",
        "cuda0=nan,default=4",
        "1e50",
        "1=2=3"}) {
    WorldSessionConfig config;
    config.maxVram = spec;
    WorldSessionModel model(config);
    try {
      model.load();
      FAIL() << spec;
    } catch (const StatusError& error) {
      EXPECT_NE(error.codeString().find("InvalidArgument"), std::string::npos);
      EXPECT_NE(std::string(error.what()).find("maxVram"), std::string::npos);
    }
  }
}

TEST_F(
    WorldSessionHandlersTest, PlacementValidationPreservesEngineAssignments) {
  for (const auto* spec :
       {"",
        "diffusion=disk",
        "disk,vae=cpu",
        "vae=disk,tae=cpu",
        "vae=cpu,default=disk",
        "diffusion=disk,vae=gpu"}) {
    EXPECT_NO_THROW(validateWorldPlacement(spec, "")) << spec;
  }
  for (const auto* spec :
       {"",
        "0",
        "-1",
        "4.5",
        "cuda0=6,vulkan0=-1",
        "*=4,all=5,default=6",
        "  , 2 , ",
        "0,4",
        "cuda0=1,cuda0=4"}) {
    EXPECT_NO_THROW(validateWorldPlacement("", spec)) << spec;
  }
}

TEST_F(WorldSessionHandlersTest, LayerStreamingUsesEngineAssignmentSyntax) {
  WorldSessionConfig config{};
  for (const auto& budget : {"6", "-1", "0", "cuda0=6,vulkan0=-1"}) {
    applyWorldSessionHandlers(config, {{"maxVram", budget}});
    EXPECT_EQ(config.maxVram, budget);
  }
  applyWorldSessionHandlers(
      config,
      {{"paramsBackend", "diffusion=disk,vae=cpu"},
       {"offloadParamsToCpu", "true"},
       {"streamLayers", "1"}});
  EXPECT_EQ(config.paramsBackend, "diffusion=disk,vae=cpu");
  EXPECT_TRUE(config.offloadParamsToCpu);
  EXPECT_TRUE(config.streamLayers);
  applyWorldSessionHandlers(config, {{"streamLayers", "0"}});
  EXPECT_FALSE(config.streamLayers);
  applyWorldSessionHandlers(config, {{"streamLayers", "true"}});
  EXPECT_TRUE(config.streamLayers);
  applyWorldSessionHandlers(config, {{"streamLayers", "false"}});
  EXPECT_FALSE(config.streamLayers);
  EXPECT_THROW(
      applyWorldSessionHandlers(config, {{"streamLayers", "yes"}}),
      StatusError);
}

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
