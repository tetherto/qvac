#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "inference-addon-cpp/GGUFShards.hpp"
#include "inference-addon-cpp/InitLoader.hpp"
#include "model-interface/AsyncWeightsLoader.hpp"
#include "model-interface/ModelMetadata.hpp"

namespace fs = std::filesystem;

namespace {

std::string findTestModelPath() {
  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#endif

  std::vector<fs::path> candidates = {
      fs::path{"models/unit-test/test-model.gguf"},
      fs::path{"../../../models/unit-test/test-model.gguf"},
      backendDir.parent_path().parent_path().parent_path() / "models" /
          "unit-test" / "test-model.gguf",
      fs::current_path() / "models" / "unit-test" / "test-model.gguf",
  };
  for (const auto& candidate : candidates) {
    if (fs::exists(candidate)) {
      return fs::absolute(candidate).string();
    }
  }
  return "";
}

std::unique_ptr<std::basic_streambuf<char>>
readFileToStreambufBinary(const std::string& path) {
  auto filebuf = std::make_unique<std::filebuf>();
  if (filebuf->open(path, std::ios::in | std::ios::binary) == nullptr) {
    return nullptr;
  }
  filebuf->pubseekpos(0, std::ios::in);
  return filebuf;
}

class MockAsyncWeightsLoader : public AsyncWeightsLoader {
public:
  using AsyncWeightsLoader::AsyncWeightsLoader;

  std::multiset<std::string> fulfilledFilenames;

  void waitForFulfillCount(std::size_t n) {
    std::unique_lock<std::mutex> lock(mu_);
    cv_.wait(lock, [&] { return fulfilledFilenames.size() >= n; });
  }

protected:
  void fulfillSplitFuture(
      const std::string& filename,
      std::unique_ptr<Buf>&& shard) override {
    if (shard == nullptr) {
      throw std::runtime_error("MockAsyncWeightsLoader received null shard");
    }
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

} // namespace

class AsyncWeightsLoaderTest : public ::testing::Test {
protected:
  void SetUp() override { testModelPath_ = findTestModelPath(); }

  std::string testModelPath_;
};

TEST_F(
    AsyncWeightsLoaderTest,
    ShardedStreamingAllowsTensorsBeforeFirstGgufShard) {
  if (!fs::exists(testModelPath_)) {
    GTEST_SKIP() << "Test model not found at: " << testModelPath_;
  }

  GGUFShards shards;
  shards.tensors_file = "test-model.tensors.txt";
  shards.gguf_files = {"test-model-00001-of-00001.gguf"};

  InitLoader initLoader;
  ModelMetaData meta;
  initLoader.init(InitLoader::LOADER_TYPE::DELAYED, [&]() {
    meta.parse(testModelPath_, shards, true /* isStreaming */, "Test");
  });

  const std::string loadingContext =
      InitLoader::getLoadingContext("EmbedAsyncWeightsLoaderTest");
  MockAsyncWeightsLoader loader(shards, initLoader, loadingContext, &meta);

  loader.setWeightsForFile(
      shards.tensors_file, std::make_unique<std::stringbuf>("tensors"));
  EXPECT_EQ(loader.fulfilledFilenames.count(shards.tensors_file), 1u);

  std::unique_ptr<std::basic_streambuf<char>> firstShardBuf =
      readFileToStreambufBinary(testModelPath_);
  ASSERT_NE(firstShardBuf, nullptr);
  loader.setWeightsForFile(shards.gguf_files.front(), std::move(firstShardBuf));

  loader.waitForFulfillCount(2);
  initLoader.waitForLoadInitialization();

  EXPECT_EQ(loader.fulfilledFilenames.count(shards.tensors_file), 1u);
  EXPECT_EQ(loader.fulfilledFilenames.count(shards.gguf_files.front()), 1u);
  EXPECT_TRUE(loader.isStreaming());
}
