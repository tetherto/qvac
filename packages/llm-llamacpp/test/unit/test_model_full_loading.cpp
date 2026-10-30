#include <filesystem>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

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
           "https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded");

    largeShardedModel_ =
        MP("Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf",
           "LARGE_SHARDED_MODEL_FIRST_SHARD_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/jmb95/Llama-3.2-1B-Instruct-Q4_0-sharded");
  }

  LlamaModel loadModel(const std::string& modelPath) {
    std::string path = modelPath;
    std::string projection;
    auto cfg = config_;
    return LlamaModel(std::move(path), std::move(projection), std::move(cfg));
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

TEST_F(ModelFullLoadingTest, Sharded_LoadsSuccessfully) {
  REQUIRE_MODEL(shardedModel_);
  LlamaModel model = loadModel(shardedModel_.path);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, Sharded_LoadFromLaterShardRequiresFirstShard) {
  REQUIRE_MODEL(shardedModel_);
  const fs::path laterShard = fs::path(shardedModel_.path).parent_path() /
                              "Qwen3-0.6B-UD-IQ1_S-00002-of-00003.gguf";
  LlamaModel model = loadModel(laterShard.string());
  EXPECT_THROW(model.waitForLoadInitialization(), qvac_errors::StatusError);
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, LargeSharded_LoadsSuccessfully) {
  REQUIRE_MODEL(largeShardedModel_);
  LlamaModel model = loadModel(largeShardedModel_.path);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}
