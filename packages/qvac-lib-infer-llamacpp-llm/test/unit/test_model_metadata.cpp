#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <string>
#include <thread>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "model-interface/ModelMetadata.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

class ModelMetadataTest : public ::testing::Test {
protected:
  void SetUp() override {
    normal_model_path_ = test_common::BaseTestModelPath::get();

    // Optional bitnet one-bit model: bitnet_b1_58-large-TQ2_0.gguf
    // https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0
    const char* bitnetEnv = std::getenv("BITNET_MODEL_PATH");
    if (bitnetEnv && fs::exists(bitnetEnv)) {
      bitnet_model_path_ = bitnetEnv;
    } else {
      std::string p =
          test_common::BaseTestModelPath::get("bitnet_b1_58-large-TQ2_0.gguf");
      if (fs::exists(p))
        bitnet_model_path_ = p;
    }

    // Optional sharded model (first shard path for disk shards test).
    const char* shardEnv = std::getenv("SHARDED_MODEL_FIRST_SHARD_PATH");
    std::string defaultShardedPath =
        test_common::BaseTestModelPath::getSharded();
    if (shardEnv && fs::exists(shardEnv)) {
      sharded_first_shard_path_ = shardEnv;
    } else if (fs::exists(defaultShardedPath)) {
      sharded_first_shard_path_ = defaultShardedPath;
    }

    if (!sharded_first_shard_path_.empty()) {
      shards_with_paths_ =
          GGUFShards::expandGGUFIntoShards(sharded_first_shard_path_);
      LlamaModel::resolveShardPaths(
          shards_with_paths_, sharded_first_shard_path_);
    }

    // Auto-discover sharded bitnet model
    // https://huggingface.co/jmb95/bitnet_b1_58-large-TQ2_0-sharded
    std::string p = test_common::BaseTestModelPath::get(
        "bitnet_b1_58-large-TQ2_0-00001-of-00008.gguf");
    if (fs::exists(p)) {
      bitnet_sharded_first_shard_path_ = p;
      bitnet_shards_with_paths_ =
          GGUFShards::expandGGUFIntoShards(bitnet_sharded_first_shard_path_);
      LlamaModel::resolveShardPaths(
          bitnet_shards_with_paths_, bitnet_sharded_first_shard_path_);
    }
  }

  std::string normal_model_path_;
  std::string bitnet_model_path_;
  std::string sharded_first_shard_path_;
  GGUFShards shards_with_paths_;
  std::string bitnet_sharded_first_shard_path_;
  GGUFShards bitnet_shards_with_paths_;

  [[nodiscard]] bool hasNormalModel() const {
    return !normal_model_path_.empty() && fs::exists(normal_model_path_);
  }
  [[nodiscard]] bool hasBitnetModel() const {
    return !bitnet_model_path_.empty() && fs::exists(bitnet_model_path_);
  }
  [[nodiscard]] bool hasShardedModel() const {
    return !shards_with_paths_.gguf_files.empty();
  }
  [[nodiscard]] bool hasShardedBitnetModel() const {
    return !bitnet_shards_with_paths_.gguf_files.empty();
  }
};

// ---- Disk single file ----

TEST_F(
    ModelMetadataTest, DiskSingleFile_NormalModel_HasOneBitQuantizationFalse) {
  if (!hasNormalModel()) {
    FAIL() << "Test model not found at: " << normal_model_path_;
  }
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> emptyMap;
  GGUFShards emptyShards;
  ModelMetaData meta;
  meta.parse(
      normal_model_path_,
      emptyMap,
      emptyShards,
      false /* isStreaming */,
      "Test");
  EXPECT_FALSE(meta.hasOneBitQuantization());
}

TEST_F(
    ModelMetadataTest, DiskSingleFile_BitnetModel_HasOneBitQuantizationTrue) {
  if (!hasBitnetModel()) {
    GTEST_SKIP()
        << "bitnet_b1_58-large-TQ2_0.gguf not found (BITNET_MODEL_PATH or "
           "models/unit-test); see "
           "https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0";
  }
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> emptyMap;
  GGUFShards emptyShards;
  ModelMetaData meta;
  meta.parse(
      bitnet_model_path_,
      emptyMap,
      emptyShards,
      false /* isStreaming */,
      "Test");
  EXPECT_TRUE(meta.hasOneBitQuantization());
}

// ---- Disk shards ----

TEST_F(ModelMetadataTest, DiskShards_NormalModel_HasOneBitQuantizationFalse) {
  if (!hasShardedModel()) {
    GTEST_SKIP() << "No sharded model in setup (set "
                    "SHARDED_MODEL_FIRST_SHARD_PATH)";
  }
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> emptyMap;
  ModelMetaData meta;
  meta.parse(
      sharded_first_shard_path_,
      emptyMap,
      shards_with_paths_,
      false /* isStreaming */,
      "Test");
  EXPECT_FALSE(meta.hasOneBitQuantization());
}

TEST_F(ModelMetadataTest, DiskShards_BitnetModel_HasOneBitQuantizationTrue) {
  if (!hasShardedBitnetModel()) {
    GTEST_SKIP() << "Sharded bitnet model not found; split with "
                    "llama-gguf-split (see test_common.hpp)";
  }
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> emptyMap;
  ModelMetaData meta;
  meta.parse(
      bitnet_sharded_first_shard_path_,
      emptyMap,
      bitnet_shards_with_paths_,
      false /* isStreaming */,
      "Test");
  EXPECT_TRUE(meta.hasOneBitQuantization());
}

// ---- Streaming single file ----

// Use a file-backed streambuf so metadata parsing reads on demand and avoids
// copying the entire GGUF file into memory during test setup.
// Note that in real scenarios, the GGUF file is streamed from the network and
// not read from disk. Still, this allows to test the streaming functionality.
static std::unique_ptr<std::basic_streambuf<char>>
readFileToStreambufBinary(const std::string& path) {
  auto buf = std::make_unique<std::filebuf>();
  if (!buf->open(path, std::ios::binary | std::ios::in)) {
    return nullptr;
  }
  return buf;
}

TEST_F(
    ModelMetadataTest,
    StreamingSingleFile_NormalModel_HasOneBitQuantizationFalse) {
  if (!hasNormalModel()) {
    FAIL() << "Test model not found at: " << normal_model_path_;
  }
  auto streambuf = readFileToStreambufBinary(normal_model_path_);
  ASSERT_NE(streambuf, nullptr);
  std::string filename = fs::path(normal_model_path_).filename().string();
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> streamed;
  streamed[filename] = std::move(streambuf);
  GGUFShards emptyShards;
  std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream(
      streamed[filename].get(), [](std::basic_streambuf<char>*) {});
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(
      normal_model_path_,
      streamed,
      emptyShards,
      true /* isStreaming */,
      "Test");
  lenderThread.join();
  EXPECT_FALSE(meta.hasOneBitQuantization());
}

TEST_F(
    ModelMetadataTest,
    StreamingSingleFile_BitnetModel_HasOneBitQuantizationTrue) {
  if (!hasBitnetModel()) {
    GTEST_SKIP()
        << "bitnet_b1_58-large-TQ2_0.gguf not found; see "
           "https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0";
  }
  auto streambuf = readFileToStreambufBinary(bitnet_model_path_);
  ASSERT_NE(streambuf, nullptr);
  std::string filename = fs::path(bitnet_model_path_).filename().string();
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> streamed;
  streamed[filename] = std::move(streambuf);
  GGUFShards emptyShards;
  std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream(
      streamed[filename].get(), [](std::basic_streambuf<char>*) {});
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(
      bitnet_model_path_,
      streamed,
      emptyShards,
      true /* isStreaming */,
      "Test");
  lenderThread.join();
  EXPECT_TRUE(meta.hasOneBitQuantization());
}

// ---- Streaming shards ----

TEST_F(
    ModelMetadataTest, StreamingShards_NormalModel_HasOneBitQuantizationFalse) {
  if (!hasShardedModel()) {
    GTEST_SKIP() << "No sharded model in setup";
  }
  std::string firstPath = shards_with_paths_.gguf_files.front();
  auto streambuf = readFileToStreambufBinary(firstPath);
  ASSERT_NE(streambuf, nullptr);
  std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream =
      std::move(streambuf);
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> emptyMap;
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(
      sharded_first_shard_path_,
      emptyMap,
      shards_with_paths_,
      true /* isStreaming */,
      "Test");
  lenderThread.join();
  EXPECT_FALSE(meta.hasOneBitQuantization());
}

TEST_F(
    ModelMetadataTest, StreamingShards_BitnetModel_HasOneBitQuantizationTrue) {
  if (!hasShardedBitnetModel()) {
    GTEST_SKIP() << "Sharded bitnet model not found; split with "
                    "llama-gguf-split (see test_common.hpp)";
  }
  std::string firstPath = bitnet_shards_with_paths_.gguf_files.front();
  auto streambuf = readFileToStreambufBinary(firstPath);
  ASSERT_NE(streambuf, nullptr);
  std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream =
      std::move(streambuf);
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> emptyMap;
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(
      bitnet_sharded_first_shard_path_,
      emptyMap,
      bitnet_shards_with_paths_,
      true /* isStreaming */,
      "Test");
  lenderThread.join();
  EXPECT_TRUE(meta.hasOneBitQuantization());
}
