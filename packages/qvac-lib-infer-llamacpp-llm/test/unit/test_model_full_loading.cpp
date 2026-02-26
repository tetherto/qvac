#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

static std::unique_ptr<std::basic_streambuf<char>>
readFileToStreambufBinary(const std::string& path) {
  auto buf = std::make_unique<std::filebuf>();
  if (!buf->open(path, std::ios::binary | std::ios::in)) {
    return nullptr;
  }
  return buf;
}

class ModelFullLoadingTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;

    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "2048";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["n_predict"] = "10";

    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
    config_["backendsDir"] = backendDir.string();

    singleModel_ = MP(
        "Llama-3.2-1B-Instruct-Q4_0.gguf",
        nullptr,
        MP::OnMissing::Fail,
        "");

    shardedModel_ = MP(
        "Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf",
        "SHARDED_MODEL_FIRST_SHARD_PATH",
        MP::OnMissing::Skip,
        "https://huggingface.co/jmb95/Llama-3.2-1B-Instruct-Q4_0-sharded",
        true /* isSharded */);
    if (shardedModel_.found())
      LlamaModel::resolveShardPaths(shardedModel_.shards, shardedModel_.path);
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
  auto streambuf = readFileToStreambufBinary(singleModel_.path);
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

TEST_F(ModelFullLoadingTest, StreamingShards_LoadsSuccessfully) {
  REQUIRE_MODEL(shardedModel_);
  LlamaModel model = loadModel(shardedModel_.path);

  std::string tensorsBasename =
      fs::path(shardedModel_.shards.tensors_file).filename().string();
  auto tensorsBuf =
      readFileToStreambufBinary(shardedModel_.shards.tensors_file);
  ASSERT_NE(tensorsBuf, nullptr)
      << "Failed to open: " << shardedModel_.shards.tensors_file;
  model.setWeightsForFile(tensorsBasename, std::move(tensorsBuf));

  for (const auto& shardPath : shardedModel_.shards.gguf_files) {
    auto streambuf = readFileToStreambufBinary(shardPath);
    ASSERT_NE(streambuf, nullptr) << "Failed to open shard: " << shardPath;
    model.setWeightsForFile(
        fs::path(shardPath).filename().string(), std::move(streambuf));
  }
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}
