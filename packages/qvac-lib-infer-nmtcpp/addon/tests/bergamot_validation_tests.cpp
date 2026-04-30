#include <filesystem>
#include <fstream>
#include <memory>

#include <gtest/gtest.h>

#include "model-interface/bergamot.hpp"

namespace fs = std::filesystem;

class BergamotValidationTest : public ::testing::Test {
protected:
  void SetUp() override {
    // Create test directory
    testDir = fs::temp_directory_path() / "bergamot_test";
    fs::create_directories(testDir);

    // Create valid test files
    validModelPath = (testDir / "model.bin").string();
    validVocabPath = (testDir / "vocab.spm").string();

    std::ofstream(validModelPath) << "dummy model data";
    std::ofstream(validVocabPath) << "dummy vocab data";

    // Create files with wrong extensions
    wrongExtModelPath = (testDir / "model.gz").string();
    wrongExtVocabPath = (testDir / "vocab.txt").string();

    std::ofstream(wrongExtModelPath) << "dummy";
    std::ofstream(wrongExtVocabPath) << "dummy";
  }

  void TearDown() override {
    // Clean up test directory
    fs::remove_all(testDir);
  }

  fs::path testDir;
  std::string validModelPath;
  std::string validVocabPath;
  std::string wrongExtModelPath;
  std::string wrongExtVocabPath;
};

TEST_F(BergamotValidationTest, ModelFileNotFound) {
  bergamot_params params;
  params.model_path = "/nonexistent/model.bin";
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, ModelWrongExtension) {
  bergamot_params params;
  params.model_path = wrongExtModelPath;
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, SrcVocabFileNotFound) {
  bergamot_params params;
  params.model_path = validModelPath;
  params.src_vocab_path = "/nonexistent/vocab.spm";
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, SrcVocabWrongExtension) {
  bergamot_params params;
  params.model_path = validModelPath;
  params.src_vocab_path = wrongExtVocabPath;
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, DstVocabFileNotFound) {
  bergamot_params params;
  params.model_path = validModelPath;
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = "/nonexistent/vocab.spm";

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, DstVocabWrongExtension) {
  bergamot_params params;
  params.model_path = validModelPath;
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = wrongExtVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, EmptyModelPath) {
  bergamot_params params;
  params.model_path = "";
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, EmptyVocabPaths) {
  bergamot_params params;
  params.model_path = validModelPath;
  params.src_vocab_path = "";
  params.dst_vocab_path = "";

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST_F(BergamotValidationTest, FilePermissionDenied) {
  // Create file with no read permissions
  std::string noReadPath = (testDir / "noread.bin").string();
  std::ofstream(noReadPath) << "data";
  fs::permissions(noReadPath, fs::perms::none);

  bergamot_params params;
  params.model_path = noReadPath;
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);

  // Restore permissions for cleanup
  fs::permissions(noReadPath, fs::perms::owner_all);
}

TEST_F(BergamotValidationTest, DirectoryInsteadOfFile) {
  // Create a directory with .bin extension
  std::string dirPath = (testDir / "notafile.bin").string();
  fs::create_directory(dirPath);

  bergamot_params params;
  params.model_path = dirPath;
  params.src_vocab_path = validVocabPath;
  params.dst_vocab_path = validVocabPath;

  auto ctx = bergamot_init("", params);
  EXPECT_EQ(ctx, nullptr);
}

TEST(BergamotValidation, DifferentDecodingParamsCanChangeOutput) {
  constexpr int kCustomBeamSize = 6;
  constexpr int kDisableNormalize = 0;
  constexpr double kShortMaxLengthFactor = 0.1;

  fs::path modelDir;
  if (fs::exists(fs::path{"models/unit-test/berg-en-it"})) {
    modelDir = fs::path{"models/unit-test/berg-en-it"};
  } else if (fs::exists(fs::path{"../../../models/unit-test/berg-en-it"})) {
    modelDir = fs::path{"../../../models/unit-test/berg-en-it"};
  } else {
    GTEST_SKIP() << "Bergamot unit-test model directory not found.";
  }

  const std::string modelPath =
      (modelDir / "model.enit.intgemm.alphas.bin").string();
  const std::string vocabPath = (modelDir / "vocab.enit.spm").string();
  if (!fs::exists(modelPath) || !fs::exists(vocabPath)) {
    GTEST_SKIP() << "Required Bergamot model files are missing in "
                 << modelDir.string();
  }

  const auto freeCtx = [](bergamot_context* ctx) {
    if (ctx != nullptr) {
      bergamot_free(ctx);
    }
  };

  bergamot_params defaultParams;
  defaultParams.model_path = modelPath;
  defaultParams.src_vocab_path = vocabPath;
  defaultParams.dst_vocab_path = vocabPath;

  bergamot_params customParams = defaultParams;
  customParams.beam_size = kCustomBeamSize;
  customParams.normalize = kDisableNormalize;
  customParams.max_length_factor = kShortMaxLengthFactor;

  std::unique_ptr<bergamot_context, decltype(freeCtx)> defaultCtx(
      bergamot_init("", defaultParams), freeCtx);
  ASSERT_NE(defaultCtx.get(), nullptr);
  std::unique_ptr<bergamot_context, decltype(freeCtx)> customCtx(
      bergamot_init("", customParams), freeCtx);
  ASSERT_NE(customCtx.get(), nullptr);

  const std::string input =
      "When the heavy rain finally stopped, everyone came outside to inspect "
      "the streets, help their neighbors, and share updates about the damage "
      "reported across the town.";

  const std::string defaultOutput =
      bergamot_translate(defaultCtx.get(), input.c_str());
  const std::string customOutput =
      bergamot_translate(customCtx.get(), input.c_str());

  EXPECT_FALSE(defaultOutput.empty());
  EXPECT_FALSE(customOutput.empty());

  // Compare outputs from different decode settings. With a stricter
  // max-length-factor in custom params, output is expected to change or
  // become shorter.
  EXPECT_NE(customOutput, defaultOutput);
}

// Note: We cannot test valid file initialization here because that would require
// actual valid Bergamot model files and would try to load them, which is beyond
// the scope of validation testing. The validation logic ensures files exist and
// have correct extensions before attempting to load them.
