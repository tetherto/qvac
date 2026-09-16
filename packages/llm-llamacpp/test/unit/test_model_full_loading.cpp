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
      LlamaModel model(
          std::move(path), std::move(projection), std::move(cfg));
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
// split file idx" otherwise (src/llama-model-loader.cpp). `expandGGUFIntoShards`
// always regenerates the list from shard 1, so naming a later shard must still
// fit against the first — which is what `gguf_files.front()` in
// LlamaModel::init buys.
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
