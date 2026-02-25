#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>

#include <gtest/gtest.h>

#include "model-interface/AsyncWeightsLoader.hpp"
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
  GGUFShards emptyShards;
  ModelMetaData meta;
  meta.parse(normal_model_path_, emptyShards, false /* isStreaming */, "Test");
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
  GGUFShards emptyShards;
  ModelMetaData meta;
  meta.parse(bitnet_model_path_, emptyShards, false /* isStreaming */, "Test");
  EXPECT_TRUE(meta.hasOneBitQuantization());
}

// ---- Disk shards ----

TEST_F(ModelMetadataTest, DiskShards_NormalModel_HasOneBitQuantizationFalse) {
  if (!hasShardedModel()) {
    GTEST_SKIP() << "No sharded model in setup (set "
                    "SHARDED_MODEL_FIRST_SHARD_PATH)";
  }
  ModelMetaData meta;
  meta.parse(sharded_first_shard_path_, shards_with_paths_, false /* isStreaming */, "Test");
  EXPECT_FALSE(meta.hasOneBitQuantization());
}

TEST_F(ModelMetadataTest, DiskShards_BitnetModel_HasOneBitQuantizationTrue) {
  if (!hasShardedBitnetModel()) {
    GTEST_SKIP() << "Sharded bitnet model not found; split with "
                    "llama-gguf-split (see test_common.hpp)";
  }
  ModelMetaData meta;
  meta.parse(bitnet_sharded_first_shard_path_, bitnet_shards_with_paths_, false /* isStreaming */, "Test");
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
  GGUFShards emptyShards;
  std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream(
      streambuf.get(), [](std::basic_streambuf<char>*) {});
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(normal_model_path_, emptyShards, true /* isStreaming */, "Test");
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
  GGUFShards emptyShards;
  std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream(
      streambuf.get(), [](std::basic_streambuf<char>*) {});
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(bitnet_model_path_, emptyShards, true /* isStreaming */, "Test");
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
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(sharded_first_shard_path_, shards_with_paths_, true /* isStreaming */, "Test");
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
  ModelMetaData meta;
  std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
    meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  meta.parse(bitnet_sharded_first_shard_path_, bitnet_shards_with_paths_, true /* isStreaming */, "Test");
  lenderThread.join();
  EXPECT_TRUE(meta.hasOneBitQuantization());
}

// ---- AsyncWeightsLoader: mock and streaming tests ----
//
// MockAsyncWeightsLoader overrides fulfillSplitFuture so tests never touch
// the global promise registry (which would leak a permanent entry because no
// llama_model_load_from_split_futures consumer is set up to erase it).
// fulfilledFilenames records every call for assertion; waitForFulfillCount()
// synchronises with the detached thread used by the sharded path.

class MockAsyncWeightsLoader : public AsyncWeightsLoader {
public:
  using AsyncWeightsLoader::AsyncWeightsLoader;

  std::multiset<std::string> fulfilledFilenames;

  /// Block until at least @p n calls to fulfillSplitFuture have been recorded.
  void waitForFulfillCount(std::size_t n) {
    std::unique_lock<std::mutex> lock(mu_);
    cv_.wait(lock, [&] { return fulfilledFilenames.size() >= n; });
  }

protected:
  void fulfillSplitFuture(
      const std::string& filename, std::unique_ptr<Buf>&&) override {
    // shard destructs here; global promise registry is not touched
    {
      std::lock_guard<std::mutex> lock(mu_);
      fulfilledFilenames.insert(filename);
    }
    cv_.notify_all();
  }

private:
  std::mutex mu_;
  std::condition_variable cv_;
};

// ---- AsyncWeightsLoader: streaming single file ----
//
// Mirrors real delayed-load usage: setWeightsForFile is called during the
// download phase (before activate()), so by the time parse() runs it finds
// the single file already in streamedFiles_ and the wait() flag already set.
// fulfillSplitFuture is never called for single-GGUF; the multiset stays empty.

TEST_F(
    ModelMetadataTest,
    AsyncLoader_SingleFile_NormalModel_MetadataParsedAndShardAvailable) {
  if (!hasNormalModel()) {
    FAIL() << "Test model not found at: " << normal_model_path_;
  }
  auto singleFileStreambuf = readFileToStreambufBinary(normal_model_path_);
  ASSERT_NE(singleFileStreambuf, nullptr);

  const std::string filename = fs::path(normal_model_path_).filename().string();
  GGUFShards emptyShards;
  InitLoader initLoader;
  const std::string loadingContext = "test-normal";
  ModelMetaData meta;
  MockAsyncWeightsLoader loader(emptyShards, initLoader, loadingContext, &meta);

  loader.setWeightsForFile(filename, std::move(singleFileStreambuf));
  meta.parse(normal_model_path_, emptyShards, true /* isStreaming */, "Test");
  auto extracted = loader.extractIndividualStreamedFiles();
  EXPECT_FALSE(meta.hasOneBitQuantization());
  EXPECT_NE(extracted.find(filename), extracted.end());
  EXPECT_TRUE(loader.fulfilledFilenames.empty());
}

TEST_F(
    ModelMetadataTest,
    AsyncLoader_SingleFile_BitnetModel_MetadataParsedAndShardAvailable) {
  if (!hasBitnetModel()) {
    GTEST_SKIP()
        << "bitnet_b1_58-large-TQ2_0.gguf not found; see "
           "https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0";
  }
  auto singleFileStreambuf = readFileToStreambufBinary(bitnet_model_path_);
  ASSERT_NE(singleFileStreambuf, nullptr);

  const std::string filename = fs::path(bitnet_model_path_).filename().string();
  GGUFShards emptyShards;
  InitLoader initLoader;
  const std::string loadingContext = "test-bitnet";
  ModelMetaData meta;
  MockAsyncWeightsLoader loader(emptyShards, initLoader, loadingContext, &meta);

  loader.setWeightsForFile(filename, std::move(singleFileStreambuf));
  meta.parse(bitnet_model_path_, emptyShards, true /* isStreaming */, "Test");
  auto extracted = loader.extractIndividualStreamedFiles();
  EXPECT_TRUE(meta.hasOneBitQuantization());
  EXPECT_NE(extracted.find(filename), extracted.end());
  EXPECT_TRUE(loader.fulfilledFilenames.empty());
}

TEST_F(
    ModelMetadataTest,
    AsyncLoader_SingleFile_NoMetadata_ShardStoredWithoutLending) {
  if (!hasNormalModel()) {
    FAIL() << "Test model not found at: " << normal_model_path_;
  }
  auto singleFileStreambuf = readFileToStreambufBinary(normal_model_path_);
  ASSERT_NE(singleFileStreambuf, nullptr);

  const std::string filename = fs::path(normal_model_path_).filename().string();
  GGUFShards emptyShards;
  InitLoader initLoader;
  const std::string loadingContext = "test-no-meta";
  // No ModelMetaData — lending is skipped entirely.
  MockAsyncWeightsLoader loader(emptyShards, initLoader, loadingContext);

  loader.setWeightsForFile(filename, std::move(singleFileStreambuf));

  auto extracted = loader.extractIndividualStreamedFiles();
  EXPECT_TRUE(loader.isStreaming());
  EXPECT_NE(extracted.find(filename), extracted.end());
  EXPECT_TRUE(loader.fulfilledFilenames.empty());
}

// ---- AsyncWeightsLoader: streaming shards ----
//
// For sharded models, parse() blocks at wait() and is unblocked by the
// detached thread that lendFirstShard() spawns inside setWeightsForFile().
// waitForFulfillCount(1) synchronises with that detached thread so assertions
// on fulfilledFilenames are race-free.

TEST_F(ModelMetadataTest, AsyncLoader_Shards_NormalModel_MetadataParsed) {
  if (!hasShardedModel()) {
    GTEST_SKIP()
        << "No sharded model in setup (set SHARDED_MODEL_FIRST_SHARD_PATH)";
  }

  // Unresolved basenames: what AsyncWeightsLoader sees during streaming.
  GGUFShards shards =
      GGUFShards::expandGGUFIntoShards(sharded_first_shard_path_);
  const std::string firstShardFilename = shards.gguf_files.front();

  // Read the first shard from disk via its resolved absolute path.
  auto firstShardBuf =
      readFileToStreambufBinary(shards_with_paths_.gguf_files.front());
  ASSERT_NE(firstShardBuf, nullptr);

  InitLoader initLoader;
  const std::string loadingContext =
      InitLoader::getLoadingContext("TestShardsNormal");
  ModelMetaData meta;
  MockAsyncWeightsLoader loader(shards, initLoader, loadingContext, &meta);

  // parse() blocks at wait() until the detached thread inside setWeightsForFile
  // provides the first shard via lendFirstShard().
  std::thread parseThread([&]() {
    meta.parse(sharded_first_shard_path_, shards_with_paths_, true /* isStreaming */, "Test");
  });

  loader.setWeightsForFile(firstShardFilename, std::move(firstShardBuf));
  parseThread.join();
  loader.waitForFulfillCount(1);

  EXPECT_FALSE(meta.hasOneBitQuantization());
  EXPECT_EQ(loader.fulfilledFilenames.count(firstShardFilename), 1u);
}

TEST_F(ModelMetadataTest, AsyncLoader_Shards_BitnetModel_MetadataParsed) {
  if (!hasShardedBitnetModel()) {
    GTEST_SKIP() << "Sharded bitnet model not found; split with "
                    "llama-gguf-split (see test_common.hpp)";
  }

  GGUFShards shards =
      GGUFShards::expandGGUFIntoShards(bitnet_sharded_first_shard_path_);
  const std::string firstShardFilename = shards.gguf_files.front();

  auto firstShardBuf =
      readFileToStreambufBinary(bitnet_shards_with_paths_.gguf_files.front());
  ASSERT_NE(firstShardBuf, nullptr);

  InitLoader initLoader;
  const std::string loadingContext =
      InitLoader::getLoadingContext("TestShardsBitnet");
  ModelMetaData meta;
  MockAsyncWeightsLoader loader(shards, initLoader, loadingContext, &meta);

  std::thread parseThread([&]() {
    meta.parse(bitnet_sharded_first_shard_path_, bitnet_shards_with_paths_, true /* isStreaming */, "Test");
  });

  loader.setWeightsForFile(firstShardFilename, std::move(firstShardBuf));
  parseThread.join();
  loader.waitForFulfillCount(1);

  EXPECT_TRUE(meta.hasOneBitQuantization());
  EXPECT_EQ(loader.fulfilledFilenames.count(firstShardFilename), 1u);
}
