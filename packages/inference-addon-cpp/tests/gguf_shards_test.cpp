#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "inference-addon-cpp/GGUFShards.hpp"

TEST(GGUFShards, ExpandsValidModelFromEitherShard) {
  for (const auto* path :
       {"model-00001-of-00002.gguf", "models/model-00002-of-00002.gguf"}) {
    const auto shards = GGUFShards::expandGGUFIntoShards(path);
    EXPECT_EQ(shards.tensors_file, "model.tensors.txt");
    EXPECT_EQ(
        shards.gguf_files,
        (std::vector<std::string>{
            "model-00001-of-00002.gguf", "model-00002-of-00002.gguf"}));
  }
}

TEST(GGUFShards, ExpandsSingleShard) {
  const auto shards =
      GGUFShards::expandGGUFIntoShards("model-00001-of-00001.gguf");
  EXPECT_EQ(shards.tensors_file, "model.tensors.txt");
  EXPECT_EQ(
      shards.gguf_files,
      (std::vector<std::string>{"model-00001-of-00001.gguf"}));
}

TEST(GGUFShards, ExpandsMaximumShardCount) {
  const auto shards =
      GGUFShards::expandGGUFIntoShards("model-99999-of-99999.gguf");
  EXPECT_EQ(shards.tensors_file, "model.tensors.txt");
  ASSERT_EQ(shards.gguf_files.size(), 99999);
  EXPECT_EQ(shards.gguf_files.front(), "model-00001-of-99999.gguf");
  EXPECT_EQ(shards.gguf_files.back(), "model-99999-of-99999.gguf");
}

class InvalidGGUFShards : public ::testing::TestWithParam<const char*> {};

TEST_P(InvalidGGUFShards, ReturnsNoShardsAndLogsError) {
  testing::internal::CaptureStdout();
  const auto shards = GGUFShards::expandGGUFIntoShards(GetParam());
  const auto log = testing::internal::GetCapturedStdout();
  EXPECT_TRUE(shards.gguf_files.empty());
  EXPECT_TRUE(shards.tensors_file.empty());
  EXPECT_NE(log.find("[ERROR]"), std::string::npos);
}

INSTANTIATE_TEST_SUITE_P(
    InvalidFilenames, InvalidGGUFShards,
    ::testing::Values(
        "model-00001-of-100000.gguf", "model-00001-of-10000000.gguf",
        "model-00001-of-2147483647.gguf", "model-00001-of-2147483648.gguf",
        "model-00001-of-00000.gguf", "model-00000-of-00002.gguf",
        "model-00003-of-00002.gguf", "model-1-of-00002.gguf",
        "model-00001-of-2.gguf", "model-000001-of-00002.gguf",
        "model-00001-of-000002.gguf"));

TEST(GGUFShards, LeavesUnshardedNamesUnchangedWithoutLogging) {
  for (const auto* path :
       {"model.gguf",
        "model-of-model.gguf",
        "model-00001-of-00002.gguf.backup",
        "model.bin"}) {
    testing::internal::CaptureStdout();
    const auto shards = GGUFShards::expandGGUFIntoShards(path);
    const auto log = testing::internal::GetCapturedStdout();
    EXPECT_TRUE(shards.gguf_files.empty());
    EXPECT_TRUE(shards.tensors_file.empty());
    EXPECT_TRUE(log.empty());
  }
}
