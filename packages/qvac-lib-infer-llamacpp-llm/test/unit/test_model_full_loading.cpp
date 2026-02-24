#include <cstdlib>
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

    single_model_path_ = test_common::BaseTestModelPath::get();

    shardedModel_ = MP(
        "Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf",
        "SHARDED_MODEL_FIRST_SHARD_PATH",
        MP::OnMissing::Skip,
        "https://huggingface.co/jmb95/Qwen3-0.6-UD-IQ1_S-sharded",
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
  std::string single_model_path_;
  std::string sharded_model_path_;
  GGUFShards shards_;
};

TEST_F(ModelFullLoadingTest, SingleFile_LoadsSuccessfully) {
  if (!fs::exists(single_model_path_)) {
    FAIL() << "Test model not found at: " << single_model_path_;
  }
  LlamaModel model = loadModel(single_model_path_);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, StreamingSingleFile_LoadsSuccessfully) {
  if (!fs::exists(single_model_path_)) {
    FAIL() << "Test model not found at: " << single_model_path_;
  }
  LlamaModel model = loadModel(single_model_path_);
  std::string filename = fs::path(single_model_path_).filename().string();
  auto streambuf = readFileToStreambufBinary(single_model_path_);
  ASSERT_NE(streambuf, nullptr) << "Failed to open: " << single_model_path_;
  model.setWeightsForFile(filename, std::move(streambuf));
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, Sharded_LoadsSuccessfully) {
  if (!fs::exists(sharded_model_path_)) {
    GTEST_SKIP() << "Sharded model not found at: " << sharded_model_path_;
  }
  LlamaModel model = loadModel(sharded_model_path_);
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ModelFullLoadingTest, StreamingShards_LoadsSuccessfully) {
  if (shards_.gguf_files.empty()) {
    GTEST_SKIP() << "Sharded model not found at: " << sharded_model_path_;
  }
  LlamaModel model = loadModel(sharded_model_path_);
  // Tensors list file first
  std::string tensorsBasename =
      fs::path(shards_.tensors_file).filename().string();
  auto tensorsBuf = readFileToStreambufBinary(shards_.tensors_file);
  ASSERT_NE(tensorsBuf, nullptr) << "Failed to open: " << shards_.tensors_file;
  model.setWeightsForFile(tensorsBasename, std::move(tensorsBuf));

  // Then each shard
  for (const auto& shardPath : shards_.gguf_files) {
    auto streambuf = readFileToStreambufBinary(shardPath);
    ASSERT_NE(streambuf, nullptr) << "Failed to open shard: " << shardPath;
    std::string filename = fs::path(shardPath).filename().string();
    model.setWeightsForFile(filename, std::move(streambuf));
  }
  model.waitForLoadInitialization();
  EXPECT_TRUE(model.isLoaded());
}
