#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>

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

// Note: We cannot test valid file initialization here because that would require
// actual valid Bergamot model files and would try to load them, which is beyond
// the scope of validation testing. The validation logic ensures files exist and
// have correct extensions before attempting to load them.
