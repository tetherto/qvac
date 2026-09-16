#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "utils/LoggingMacros.hpp"

namespace fs = std::filesystem;

class ModelFullLoadingTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;

    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "2048";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["n_predict"] = "10";

    config_["backendsDir"] = test_common::getTestBackendsDir().string();

    singleModel_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf", nullptr, MP::OnMissing::Fail, "");

    shardedModel_ =
        MP("Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf",
           "SHARDED_MODEL_FIRST_SHARD_PATH",
           MP::OnMissing::Fail,
           "https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded",
           true /* isSharded */);
    if (shardedModel_.found())
      LlamaModel::resolveShardPaths(shardedModel_.shards, shardedModel_.path);

    largeShardedModel_ =
        MP("Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf",
           "LARGE_SHARDED_MODEL_FIRST_SHARD_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/jmb95/Llama-3.2-1B-Instruct-Q4_0-sharded",
           true /* isSharded */);
    if (largeShardedModel_.found())
      LlamaModel::resolveShardPaths(
          largeShardedModel_.shards, largeShardedModel_.path);
  }

  LlamaModel loadModel(const std::string& modelPath) {
    std::string path = modelPath;
    std::string projection;
    auto cfg = config_;
    return LlamaModel(std::move(path), std::move(projection), std::move(cfg));
  }

  /// Loads @p modelPath at INFO verbosity and returns everything the addon
  /// logged while doing it.
  ///
  /// The capture and the global verbosity are both restored on every exit,
  /// including a throwing load: gtest permits only one stdout capturer at a
  /// time, so leaking one takes down every later test in the binary rather than
  /// just this one.
  std::string captureLoadLog(const std::string& modelPath, bool expectLoaded) {
    namespace logging = qvac_lib_inference_addon_llama::logging;
    const auto priorVerbosity = logging::g_verbosityLevel;

    auto cfg = config_;
    cfg["verbosity"] = "2"; // INFO, so the outcome line is not suppressed

    std::string logged;
    bool loaded = false;
    testing::internal::CaptureStdout();
    try {
      std::string path = modelPath;
      std::string projection;
      LlamaModel model(std::move(path), std::move(projection), std::move(cfg));
      model.waitForLoadInitialization();
      loaded = model.isLoaded();
    } catch (...) {
      logged = testing::internal::GetCapturedStdout();
      logging::g_verbosityLevel = priorVerbosity;
      throw;
    }
    logged = testing::internal::GetCapturedStdout();
    logging::g_verbosityLevel = priorVerbosity;

    EXPECT_EQ(loaded, expectLoaded) << "captured log:\n" << logged;
    return logged;
  }

  /// What an unpinned load ended up with, for the assertion that the loader
  /// actually consumes the fit's verdict rather than merely logging it.
  ///
  /// `gpu_layers` and `ctx_size` are dropped from the config on purpose: the
  /// rest of this fixture pins both, and fabric treats a pinned value as user
  /// intent it must not override, so a pinned load can never show the fit's
  /// decision reaching the model. The model is kept alive until after
  /// `getCommonParams()` is read, which is why this does not go through
  /// `captureLoadLog`.
  struct UnpinnedLoad {
    std::string logged;
    bool loaded = false;
    int32_t nGpuLayers = 0;
  };

  UnpinnedLoad loadUnpinned(const std::string& modelPath) {
    namespace logging = qvac_lib_inference_addon_llama::logging;
    const auto priorVerbosity = logging::g_verbosityLevel;

    auto cfg = config_;
    cfg.erase("gpu_layers");
    cfg.erase("ctx_size");
    cfg["verbosity"] = "2"; // INFO, so the outcome line is not suppressed

    UnpinnedLoad out;
    testing::internal::CaptureStdout();
    try {
      std::string path = modelPath;
      std::string projection;
      LlamaModel model(std::move(path), std::move(projection), std::move(cfg));
      model.waitForLoadInitialization();
      out.loaded = model.isLoaded();
      if (out.loaded) {
        out.nGpuLayers = model.getCommonParams().n_gpu_layers;
      }
    } catch (...) {
      out.logged = testing::internal::GetCapturedStdout();
      logging::g_verbosityLevel = priorVerbosity;
      throw;
    }
    out.logged = testing::internal::GetCapturedStdout();
    logging::g_verbosityLevel = priorVerbosity;
    return out;
  }

  /// Asserts that whatever the fit decided is what the loaded model runs with.
  ///
  /// Three verdicts are possible on an arbitrary host and all three are
  /// checkable: "applied" names the chosen `n_gpu_layers`, which the model must
  /// then carry; "no changes needed" and "did not apply" both mean the request
  /// stands, so the model must still carry the unpinned sentinel. What is *not*
  /// acceptable on any host is the fit being skipped, or a placement being
  /// logged that the model did not take.
  static void expectTheFitReachedTheModel(const UnpinnedLoad& load) {
    ASSERT_TRUE(load.loaded) << "captured log:\n" << load.logged;
    ASSERT_NE(
        load.logged.find("[LlamaModel] automatic placement"), std::string::npos)
        << "the fitter was never reached; captured log:\n"
        << load.logged;
    ASSERT_EQ(
        load.logged.find("[LlamaModel] skipping automatic placement"),
        std::string::npos)
        << "the fit was skipped before it ran; captured log:\n"
        << load.logged;

    static constexpr const char* kApplied =
        "[LlamaModel] automatic placement applied: n_gpu_layers=";
    const size_t appliedAt = load.logged.find(kApplied);
    if (appliedAt == std::string::npos) {
      // Nothing moved, so the unpinned request has to have survived intact.
      EXPECT_EQ(load.nGpuLayers, -1)
          << "no placement was applied, but the model did not keep the "
             "unpinned request; captured log:\n"
          << load.logged;
      return;
    }

    const int32_t announced = static_cast<int32_t>(std::strtol(
        load.logged.c_str() + appliedAt + std::strlen(kApplied), nullptr, 10));
    EXPECT_EQ(load.nGpuLayers, announced)
        << "the placement was logged but the loaded model runs with something "
           "else; captured log:\n"
        << load.logged;
  }

  void streamShardsIntoModel(
      LlamaModel& model, const test_common::TestModelPath& mp) {
    std::string tensorsBasename =
        fs::path(mp.shards.tensors_file).filename().string();
    auto tensorsBuf =
        test_common::readFileToStreambufBinary(mp.shards.tensors_file);
    ASSERT_NE(tensorsBuf, nullptr)
        << "Failed to open: " << mp.shards.tensors_file;
    model.setWeightsForFile(tensorsBasename, std::move(tensorsBuf));

    for (const auto& shardPath : mp.shards.gguf_files) {
      auto streambuf = test_common::readFileToStreambufBinary(shardPath);
      ASSERT_NE(streambuf, nullptr) << "Failed to open shard: " << shardPath;
      model.setWeightsForFile(
          fs::path(shardPath).filename().string(), std::move(streambuf));
    }
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath singleModel_;
  test_common::TestModelPath shardedModel_;
  test_common::TestModelPath largeShardedModel_;
};

TEST_F(ModelFullLoadingTest, SingleFile_LoadsSuccessfully) {
  REQUIRE_MODEL(singleModel_);
  LlamaModel model = loadModel(singleModel_.path);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, StreamingSingleFile_LoadsSuccessfully) {
  REQUIRE_MODEL(singleModel_);
  LlamaModel model = loadModel(singleModel_.path);
  std::string filename = fs::path(singleModel_.path).filename().string();
  auto streambuf = test_common::readFileToStreambufBinary(singleModel_.path);
  ASSERT_NE(streambuf, nullptr) << "Failed to open: " << singleModel_.path;
  model.setWeightsForFile(filename, std::move(streambuf));
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, Sharded_LoadsSuccessfully) {
  REQUIRE_MODEL(shardedModel_);
  LlamaModel model = loadModel(shardedModel_.path);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

// QVAC-25039: the from-disk sharded arm bypasses `common_init_from_params`
// altogether — `initFromShards` goes straight to `llama_model_load_from_splits`
// — so fabric's automatic placement never ran for it, on any shard count.
//
// The assertion deliberately does not name a verdict. Which one this reaches is
// a property of the host: on a machine with room for the whole model fabric's
// step-1 check finds nothing to change and reports SUCCESS, while a constrained
// one reports "did not apply". All four outcome lines share the
// "[LlamaModel] automatic placement" prefix, and the early-return branch logs
// "[LlamaModel] skipping automatic placement" instead — so that prefix
// distinguishes "the fitter was reached" from "it was skipped" without pinning
// the test to a particular machine.
TEST_F(ModelFullLoadingTest, ShardedLoadReachesTheAutomaticPlacement) {
  REQUIRE_MODEL(shardedModel_);
  const std::string logged =
      captureLoadLog(shardedModel_.path, /*expectLoaded=*/true);

  EXPECT_NE(logged.find("[LlamaModel] automatic placement"), std::string::npos)
      << "the fitter was never reached on the sharded path; captured log:\n"
      << logged;
  EXPECT_EQ(
      logged.find("[LlamaModel] skipping automatic placement"),
      std::string::npos)
      << "the fit was skipped before it ran; captured log:\n"
      << logged;
}

// The fitter has to be handed split 0: llama reads `split.count` from the file
// it is given, checks that file's own `split.no` is 0, and throws "illegal
// split file idx" otherwise (src/llama-model-loader.cpp).
// `expandGGUFIntoShards` always regenerates the list from shard 1, so naming a
// later shard must still fit against the first — which is what
// `gguf_files.front()` in LlamaModel::init buys.
//
// That throw is the assertion. It surfaces as COMMON_PARAMS_FIT_STATUS_ERROR
// and logs "hit an internal error", so passing `modelPath` instead of
// `gguf_files.front()` fails this test. The success line does not carry the
// path, so there is nothing to match on directly.
TEST_F(ModelFullLoadingTest, ShardedFitUsesTheFirstShardNotTheNamedOne) {
  REQUIRE_MODEL(shardedModel_);
  ASSERT_GE(shardedModel_.shards.gguf_files.size(), 2U);
  const std::string& secondShard = shardedModel_.shards.gguf_files[1];

  const std::string logged = captureLoadLog(secondShard, /*expectLoaded=*/true);

  EXPECT_NE(logged.find("[LlamaModel] automatic placement"), std::string::npos)
      << "the fitter was never reached; captured log:\n"
      << logged;
  EXPECT_EQ(logged.find("hit an internal error"), std::string::npos)
      << "the fit was handed the shard the caller named rather than split 0; "
         "captured log:\n"
      << logged;
}

// The other half of the QVAC-25039 claim. The two tests above prove the fitter
// is *reached* on each on-disk path; these prove its answer is what the model
// is then built with, which is what "the fit now works" actually has to mean.
//
// Deliberately not a memory-pressure test. Which placement fabric picks is a
// function of free device memory at the instant the probe runs, so a unit test
// that asserted a particular redistribution would be asserting the state of the
// machine, not the behaviour of this code. Asserting that the model carries
// whatever was decided holds on every host, including CI's CPU-only runners.
// Real GPU and MoE redistribution is validated by hand and by the desktop
// integration suite, which runs inference against the loaded model.
TEST_F(ModelFullLoadingTest, SingleFileFitResultIsWhatTheModelRunsWith) {
  REQUIRE_MODEL(singleModel_);
  expectTheFitReachedTheModel(loadUnpinned(singleModel_.path));
}

TEST_F(ModelFullLoadingTest, ShardedFitResultIsWhatTheModelRunsWith) {
  REQUIRE_MODEL(shardedModel_);
  expectTheFitReachedTheModel(loadUnpinned(shardedModel_.path));
}

// `fit_params` must survive the load on *both* on-disk arms, and it is not the
// fit gate alone: fabric derives `cparams.moe_cache_auto` from the same flag
// (`common_context_params_to_llama`), and that is what lets `--fit` size an
// automatic MoE cache — 10% of the expert weight bytes (`fit.cpp`) — and what
// turns "the budget cannot hold one routed layer's working set" from a throw
// into a logged "cache inactive". Clearing it to stop a second in-place fit
// would silently disable that on one arm only, so the same model would behave
// differently depending on whether its GGUF is split.
//
// This asserts the precondition rather than the MoE cache itself: neither test
// fixture is an MoE model, so `moe_cache_size` stays 0 on both regardless. What
// is checkable everywhere, and what regressed if the flag were cleared again,
// is that the flag reaches the loaded context intact.
TEST_F(ModelFullLoadingTest, BothDiskArmsKeepFitParamsForTheLoadedContext) {
  REQUIRE_MODEL(singleModel_);
  {
    LlamaModel model = loadModel(singleModel_.path);
    model.waitForLoadInitialization();
    ASSERT_TRUE(model.isLoaded());
    EXPECT_TRUE(model.getCommonParams().fit_params)
        << "the single-file arm cleared fit_params, which also clears "
           "moe_cache_auto";
  }

  REQUIRE_MODEL(shardedModel_);
  {
    LlamaModel model = loadModel(shardedModel_.path);
    model.waitForLoadInitialization();
    ASSERT_TRUE(model.isLoaded());
    EXPECT_TRUE(model.getCommonParams().fit_params)
        << "the sharded arm cleared fit_params, which also clears "
           "moe_cache_auto";
  }
}

TEST_F(ModelFullLoadingTest, StreamingShards_LoadsSuccessfully) {
  REQUIRE_MODEL(shardedModel_);
  LlamaModel model = loadModel(shardedModel_.path);
  streamShardsIntoModel(model, shardedModel_);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, LargeSharded_LoadsSuccessfully) {
  REQUIRE_MODEL(largeShardedModel_);
  LlamaModel model = loadModel(largeShardedModel_.path);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, StreamingLargeShards_LoadsSuccessfully) {
  REQUIRE_MODEL(largeShardedModel_);
  LlamaModel model = loadModel(largeShardedModel_.path);
  streamShardsIntoModel(model, largeShardedModel_);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}
