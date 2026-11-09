#include <chrono>
#include <filesystem>
#include <memory>
#include <sstream>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/LlamaModelLoader.hpp"
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
  meta.parse(test_model_path_, "Test");

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
  meta.parse(test_model_path_, "Test");

  EXPECT_FALSE(meta.tryGetU32("definitely.not.a.real.key").has_value());
}

TEST_F(ModelMetadataTest, PoolingTypeAndTensorsFromDisk) {
  if (!fs::exists(test_model_path_)) {
    GTEST_SKIP() << "Test model not found at: " << test_model_path_;
  }

  ModelMetaData meta;
  meta.parse(test_model_path_, "Test");

  // embeddinggemma pools by mean and has no classifier head.
  EXPECT_EQ(meta.tryGetPoolingType(), 1U);
  EXPECT_EQ(meta.hasAnyTensor({"token_embd.weight"}), true);
  EXPECT_EQ(meta.hasAnyTensor({"cls.weight", "cls.output.weight"}), false);
  // Any one match is enough, whichever position it is in.
  EXPECT_EQ(meta.hasAnyTensor({"cls.weight", "token_embd.weight"}), true);
}

class DiskShardMetadataTest : public ::testing::Test {
protected:
  fs::path directory_;
  fs::path first_;
  fs::path second_;

  void SetUp() override {
    directory_ =
        fs::temp_directory_path() /
        ("qvac-disk-shard-metadata-" +
         std::to_string(
             std::chrono::steady_clock::now().time_since_epoch().count()));
    ASSERT_TRUE(fs::create_directory(directory_));
    first_ = directory_ / "model-00001-of-00002.gguf";
    second_ = directory_ / "model-00002-of-00002.gguf";
    writeShard(first_, 0, "token_embd.weight");
    writeShard(second_, 1, "cls.weight");
  }

  void TearDown() override { fs::remove_all(directory_); }

  static void
  writeShard(const fs::path& path, uint16_t index, const char* tensorName) {
    std::unique_ptr<ggml_context, decltype(&ggml_free)> tensors(
        ggml_init(
            ggml_init_params{
                .mem_size = 4096, .mem_buffer = nullptr, .no_alloc = true}),
        ggml_free);
    ASSERT_NE(tensors, nullptr);
    auto* tensor = ggml_new_tensor_1d(tensors.get(), GGML_TYPE_F32, 1);
    ggml_set_name(tensor, tensorName);
    std::unique_ptr<gguf_context, decltype(&gguf_free)> header(
        gguf_init_empty(), gguf_free);
    gguf_set_val_u16(header.get(), "split.no", index);
    gguf_set_val_u16(header.get(), "split.count", 2);
    gguf_add_tensor(header.get(), tensor);
    ASSERT_TRUE(gguf_write_to_file(header.get(), path.string().c_str(), true));
  }
};

TEST_F(DiskShardMetadataTest, FindsClassifierInLaterShardFromFirstDiskPath) {
  ModelMetaData meta;
  meta.parse(first_.string(), "Test");
  EXPECT_EQ(meta.hasAnyTensor({"token_embd.weight"}), true);
  EXPECT_EQ(meta.hasAnyTensor({"cls.weight", "cls.output.weight"}), true);
  EXPECT_EQ(meta.hasAnyTensor({"missing.weight"}), false);
}

TEST_F(DiskShardMetadataTest, MissingLaterShardIsUnreadable) {
  fs::remove(second_);
  ModelMetaData meta;
  meta.parse(first_.string(), "Test");
  EXPECT_FALSE(meta.hasAnyTensor({"cls.weight"}).has_value());
}

TEST_F(DiskShardMetadataTest, FilenameCannotOverrideHeaderShardCount) {
  const fs::path misleading = directory_ / "model-00001-of-10000000.gguf";
  fs::rename(first_, misleading);
  ModelMetaData meta;
  meta.parse(misleading.string(), "Test");
  EXPECT_EQ(meta.hasAnyTensor({"token_embd.weight"}), true);
  EXPECT_FALSE(meta.hasAnyTensor({"cls.weight"}).has_value());
}

TEST(LlamaModelLoaderTest, RejectsWeightBuffersBeforeDiskLoading) {
  LlamaModelLoader loader(
      {}, "model-00001-of-00003.gguf", {{"device", "cpu"}}, "");
  EXPECT_THROW(
      loader.setWeightsForFile(
          "model.tensors.txt", std::make_unique<std::stringbuf>("tensors")),
      qvac_errors::StatusError);
  EXPECT_THROW(
      loader.setWeightsForFile(
          "model-00001-of-00003.gguf",
          std::make_unique<std::stringbuf>("weights")),
      qvac_errors::StatusError);
  EXPECT_FALSE(loader.isLoaded());
}
