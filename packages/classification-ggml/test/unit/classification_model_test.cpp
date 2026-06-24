#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>

#include "model-interface/ClassificationModel.hpp"
#include "model-interface/ImagePreprocessor.hpp"
#include "model-interface/MobileNetGraph.hpp"

namespace qcc = classification_ggml;
namespace qpp = classification_ggml::preprocess;
namespace qgraph = classification_ggml::graph;

namespace {

/// Resolves the FP16 weights path. Priority:
/// 1. QVAC_CLASSIFICATION_MODEL_PATH env var (used by CI).
/// 2. Bundled weights/ directory, walked up from the current binary.
std::string findWeightsPath() {
  const char* env = std::getenv("QVAC_CLASSIFICATION_MODEL_PATH");
  if (env != nullptr && std::filesystem::exists(env)) {
    return env;
  }
  std::filesystem::path here = std::filesystem::current_path();
  for (int i = 0; i < 6; ++i) {
    const auto candidate =
        here / "weights" / "mobilenetv3_3class_v3_fp16.gguf";
    if (std::filesystem::exists(candidate)) {
      return candidate.string();
    }
    if (!here.has_parent_path()) break;
    here = here.parent_path();
  }
  return "";
}

class ClassificationModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    weightsPath_ = findWeightsPath();
    if (weightsPath_.empty()) {
      GTEST_SKIP() << "Model weights file not found; skipping (set "
                      "QVAC_CLASSIFICATION_MODEL_PATH to run).";
    }
  }
  std::string weightsPath_;
};

} // namespace

TEST(MobileNetGraphTest, ArchitectureMatches34ConvAnd2Linear) {
  // Static architecture sanity check: 1 (stem) + Σ convs-per-block + 1 (tail) = 34
  int totalConvs = 1 /*stem*/ + 1 /*tail*/;
  int totalSeBlocks = 0;
  for (const qgraph::BlockConfig& b : qgraph::BLOCKS) {
    const bool hasExpand = b.expandedChannels != b.inputChannels;
    // expand + depthwise + project
    totalConvs += (hasExpand ? 1 : 0) + 1 + 1;
    if (b.useSe) ++totalSeBlocks;
  }
  EXPECT_EQ(totalConvs, 34);
  EXPECT_EQ(totalSeBlocks, 9)
      << "MobileNetV3-Small has 9 SE blocks (features 1, 4-11)";
}

TEST_F(ClassificationModelTest, LoadSucceedsAndRunsInference) {
  qcc::ClassificationModel model(weightsPath_);
  ASSERT_NO_THROW(model.load());

  // Feed a neutral gray image; we only care that it runs and returns 3 valid
  // probabilities, not about accuracy in this test.
  std::vector<uint8_t> rawGray(qpp::INPUT_SIZE * qpp::INPUT_SIZE * 3, 128);
  qcc::ClassifyInput input;
  input.data = rawGray;
  input.rawRgb = qcc::RawRgbDims{qpp::INPUT_SIZE, qpp::INPUT_SIZE, 3};

  std::any out;
  ASSERT_NO_THROW(out = model.process(input));
  const auto* result = std::any_cast<qcc::ClassifyOutput>(&out);
  ASSERT_NE(result, nullptr);
  ASSERT_EQ(result->results.size(), qgraph::NUM_CLASSES);

  float sum = 0.0F;
  for (const qcc::ClassifyResult& r : result->results) {
    EXPECT_GE(r.confidence, 0.0F);
    EXPECT_LE(r.confidence, 1.0F);
    EXPECT_FALSE(r.label.empty());
    sum += r.confidence;
  }
  EXPECT_NEAR(sum, 1.0F, 1e-3F) << "softmax probabilities should sum to ~1.0";
  EXPECT_GE(result->results[0].confidence, result->results[1].confidence)
      << "results must be sorted by confidence descending";
}

TEST_F(ClassificationModelTest, SequentialInferenceIsDeterministic) {
  qcc::ClassificationModel model(weightsPath_);
  ASSERT_NO_THROW(model.load());

  std::vector<uint8_t> rawGray(qpp::INPUT_SIZE * qpp::INPUT_SIZE * 3, 128);
  qcc::ClassifyInput input;
  input.data = rawGray;
  input.rawRgb = qcc::RawRgbDims{qpp::INPUT_SIZE, qpp::INPUT_SIZE, 3};

  std::any a = model.process(input);
  std::any b = model.process(input);
  const auto* ra = std::any_cast<qcc::ClassifyOutput>(&a);
  const auto* rb = std::any_cast<qcc::ClassifyOutput>(&b);
  ASSERT_NE(ra, nullptr);
  ASSERT_NE(rb, nullptr);
  ASSERT_EQ(ra->results.size(), rb->results.size());
  for (size_t i = 0; i < ra->results.size(); ++i) {
    EXPECT_EQ(ra->results[i].label, rb->results[i].label);
    EXPECT_NEAR(ra->results[i].confidence, rb->results[i].confidence, 1e-6F);
  }
}

TEST_F(ClassificationModelTest, TopKFiltersResults) {
  qcc::ClassificationModel model(weightsPath_);
  ASSERT_NO_THROW(model.load());

  std::vector<uint8_t> rawGray(qpp::INPUT_SIZE * qpp::INPUT_SIZE * 3, 128);
  qcc::ClassifyInput input;
  input.data = rawGray;
  input.rawRgb = qcc::RawRgbDims{qpp::INPUT_SIZE, qpp::INPUT_SIZE, 3};
  input.topK = 1;

  std::any out = model.process(input);
  const auto* res = std::any_cast<qcc::ClassifyOutput>(&out);
  ASSERT_NE(res, nullptr);
  EXPECT_EQ(res->results.size(), 1U);
}

TEST(BatchNormFoldingTest, EpsilonIsZeroPointZeroZeroOne) {
  // The spec fixes BN epsilon at 0.001 (architecture-specific, matches the
  // original MobileNetV3 paper and the torchvision `mobilenet_v3_small`
  // default). Guards against a regression to the generic 1e-5 that causes
  // normalisation drift to accumulate across all 34 layers of the network.
  EXPECT_FLOAT_EQ(qgraph::BATCH_NORM_EPSILON, 0.001F);
}
