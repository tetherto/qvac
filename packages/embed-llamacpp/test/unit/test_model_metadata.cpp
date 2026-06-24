#include <filesystem>
#include <fstream>
#include <memory>
#include <thread>

#include <gtest/gtest.h>

#include "inference-addon-cpp/GGUFShards.hpp"
#include "model-interface/ModelMetadata.hpp"
#include "utils/BorrowablePtr.hpp"

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

} // namespace

class ModelMetadataTest : public ::testing::Test {
protected:
  void SetUp() override { test_model_path_ = findTestModelPath(); }

  std::string test_model_path_;
};

TEST_F(ModelMetadataTest, DiskSingleFileParsesArchitectureAndContextLength) {
  if (!fs::exists(test_model_path_)) {
    GTEST_SKIP() << "Test model not found at: " << test_model_path_;
  }

  ModelMetaData meta;
  GGUFShards emptyShards;
  meta.parse(test_model_path_, emptyShards, false /* isStreaming */, "Test");

  std::optional<std::string> architecture =
      meta.tryGetString("general.architecture");
  ASSERT_TRUE(architecture.has_value());
  EXPECT_FALSE(architecture->empty());

  const std::string contextLengthKey = *architecture + ".context_length";
  std::optional<uint32_t> contextLength =
      meta.tryGetU32(contextLengthKey.c_str());
  ASSERT_TRUE(contextLength.has_value());
  EXPECT_GT(*contextLength, 0U);
}

TEST_F(ModelMetadataTest, TryGetU32ReturnsNulloptForUnknownKey) {
  if (!fs::exists(test_model_path_)) {
    GTEST_SKIP() << "Test model not found at: " << test_model_path_;
  }

  ModelMetaData meta;
  GGUFShards emptyShards;
  meta.parse(test_model_path_, emptyShards, false /* isStreaming */, "Test");

  EXPECT_FALSE(meta.tryGetU32("definitely.not.a.real.key").has_value());
}

TEST_F(ModelMetadataTest, StreamingSingleFileMatchesDiskParse) {
  if (!fs::exists(test_model_path_)) {
    GTEST_SKIP() << "Test model not found at: " << test_model_path_;
  }

  ModelMetaData diskMeta;
  GGUFShards emptyShards;
  diskMeta.parse(
      test_model_path_, emptyShards, false /* isStreaming */, "Test");
  std::optional<std::string> diskArch =
      diskMeta.tryGetString("general.architecture");
  ASSERT_TRUE(diskArch.has_value());
  const std::string contextLengthKey = *diskArch + ".context_length";
  std::optional<uint32_t> diskCtx =
      diskMeta.tryGetU32(contextLengthKey.c_str());
  ASSERT_TRUE(diskCtx.has_value());

  std::unique_ptr<std::basic_streambuf<char>> streambuf =
      readFileToStreambufBinary(test_model_path_);
  ASSERT_NE(streambuf, nullptr);
  BorrowablePtr<std::basic_streambuf<char>> firstFileFromGgufStream(
      std::move(streambuf));

  ModelMetaData streamMeta;
  std::thread lender([&]() {
    streamMeta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
  });
  streamMeta.parse(
      test_model_path_, emptyShards, true /* isStreaming */, "Test");
  lender.join();

  std::optional<std::string> streamArch =
      streamMeta.tryGetString("general.architecture");
  ASSERT_TRUE(streamArch.has_value());
  EXPECT_EQ(*streamArch, *diskArch);
  std::optional<uint32_t> streamCtx =
      streamMeta.tryGetU32(contextLengthKey.c_str());
  ASSERT_TRUE(streamCtx.has_value());
  EXPECT_EQ(*streamCtx, *diskCtx);

  EXPECT_NO_THROW(firstFileFromGgufStream.reclaimUnique());
}
