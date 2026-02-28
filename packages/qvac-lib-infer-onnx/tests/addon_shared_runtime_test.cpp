#include <gtest/gtest.h>

#include <future>
#include <string>
#include <vector>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-onnx/OnnxRuntime.hpp"
#include "qvac-onnx/OnnxSession.hpp"

namespace oa = onnx_addon;
namespace logger = qvac_lib_inference_addon_cpp::logger;

#ifndef TEST_FIXTURES_DIR
#error "TEST_FIXTURES_DIR must be defined at compile time"
#endif

static std::string fixturePath(const std::string& name) {
  return std::string(TEST_FIXTURES_DIR) + "/" + name;
}

// ---------------------------------------------------------------------------
// Simulated consumer addon A: identity-based normalizer
// ---------------------------------------------------------------------------

class AddonNormalizer {
 public:
  explicit AddonNormalizer(const std::string& modelPath)
      : session_(modelPath, oa::SessionConfig{
                                .provider = oa::ExecutionProvider::CPU,
                                .enableXnnpack = false}) {
    QLOG(logger::Priority::INFO, "[AddonNormalizer] Initialized with model: " + modelPath);
  }

  std::vector<float> normalize(const std::vector<float>& input) {
    QLOG(logger::Priority::DEBUG,
         "[AddonNormalizer] Running normalize with " +
             std::to_string(input.size()) + " elements");
    oa::InputTensor tensor{.name = "X",
                           .shape = {1, static_cast<int64_t>(input.size())},
                           .type = oa::TensorType::FLOAT32,
                           .data = input.data(),
                           .dataSize = input.size() * sizeof(float)};
    auto results = session_.run(tensor);
    const float* out = results[0].as<float>();
    QLOG(logger::Priority::DEBUG, "[AddonNormalizer] Normalize complete");
    return {out, out + results[0].elementCount()};
  }

  oa::OnnxRuntime& runtime() { return oa::OnnxRuntime::instance(); }

  bool isValid() const { return session_.isValid(); }

 private:
  oa::OnnxSession session_;
};

// ---------------------------------------------------------------------------
// Simulated consumer addon B: arithmetic combiner using add model
// ---------------------------------------------------------------------------

class AddonCombiner {
 public:
  explicit AddonCombiner(const std::string& modelPath)
      : session_(modelPath, oa::SessionConfig{
                                .provider = oa::ExecutionProvider::CPU,
                                .enableXnnpack = false}) {
    QLOG(logger::Priority::INFO, "[AddonCombiner] Initialized with model: " + modelPath);
  }

  std::vector<float> combine(const std::vector<float>& a,
                             const std::vector<float>& b) {
    QLOG(logger::Priority::DEBUG,
         "[AddonCombiner] Running combine with " +
             std::to_string(a.size()) + " elements per input");
    std::vector<oa::InputTensor> inputs = {
        {.name = "A",
         .shape = {1, static_cast<int64_t>(a.size())},
         .type = oa::TensorType::FLOAT32,
         .data = a.data(),
         .dataSize = a.size() * sizeof(float)},
        {.name = "B",
         .shape = {1, static_cast<int64_t>(b.size())},
         .type = oa::TensorType::FLOAT32,
         .data = b.data(),
         .dataSize = b.size() * sizeof(float)}};
    auto results = session_.run(inputs);
    const float* out = results[0].as<float>();
    QLOG(logger::Priority::DEBUG, "[AddonCombiner] Combine complete");
    return {out, out + results[0].elementCount()};
  }

  oa::OnnxRuntime& runtime() { return oa::OnnxRuntime::instance(); }

  bool isValid() const { return session_.isValid(); }

 private:
  oa::OnnxSession session_;
};

// ---------------------------------------------------------------------------
// Tests: both addons share a single OnnxRuntime instance
// ---------------------------------------------------------------------------

class AddonSharedRuntimeTest : public ::testing::Test {
 protected:
  void SetUp() override {
    normalizer_ = std::make_unique<AddonNormalizer>(
        fixturePath("identity.onnx"));
    combiner_ = std::make_unique<AddonCombiner>(
        fixturePath("add.onnx"));
  }

  std::unique_ptr<AddonNormalizer> normalizer_;
  std::unique_ptr<AddonCombiner> combiner_;
};

TEST_F(AddonSharedRuntimeTest, BothAddonsAreValid) {
  EXPECT_TRUE(normalizer_->isValid());
  EXPECT_TRUE(combiner_->isValid());
}

TEST_F(AddonSharedRuntimeTest, BothAddonsShareSameRuntimeInstance) {
  EXPECT_EQ(&normalizer_->runtime(), &combiner_->runtime());
}

TEST_F(AddonSharedRuntimeTest, BothAddonsShareSameEnv) {
  auto& env1 = normalizer_->runtime().env();
  auto& env2 = combiner_->runtime().env();
  EXPECT_EQ(&env1, &env2);
}

TEST_F(AddonSharedRuntimeTest, NormalizerProducesCorrectResults) {
  std::vector<float> input = {1.0f, 2.0f, 3.0f, 4.0f};
  auto result = normalizer_->normalize(input);
  ASSERT_EQ(result.size(), 4);
  EXPECT_FLOAT_EQ(result[0], 1.0f);
  EXPECT_FLOAT_EQ(result[1], 2.0f);
  EXPECT_FLOAT_EQ(result[2], 3.0f);
  EXPECT_FLOAT_EQ(result[3], 4.0f);
}

TEST_F(AddonSharedRuntimeTest, CombinerProducesCorrectResults) {
  std::vector<float> a = {1.0f, 2.0f, 3.0f, 4.0f};
  std::vector<float> b = {10.0f, 20.0f, 30.0f, 40.0f};
  auto result = combiner_->combine(a, b);
  ASSERT_EQ(result.size(), 4);
  EXPECT_FLOAT_EQ(result[0], 11.0f);
  EXPECT_FLOAT_EQ(result[1], 22.0f);
  EXPECT_FLOAT_EQ(result[2], 33.0f);
  EXPECT_FLOAT_EQ(result[3], 44.0f);
}

TEST_F(AddonSharedRuntimeTest, InterleavedInferenceSharesSingleRuntime) {
  std::vector<float> data = {5.0f, 6.0f, 7.0f, 8.0f};

  // Alternate between addons to confirm shared runtime stays stable
  auto r1 = normalizer_->normalize(data);
  auto r2 = combiner_->combine(data, data);
  auto r3 = normalizer_->normalize(data);
  auto r4 = combiner_->combine(r1, r3);

  EXPECT_FLOAT_EQ(r1[0], 5.0f);
  EXPECT_FLOAT_EQ(r2[0], 10.0f);
  EXPECT_FLOAT_EQ(r3[0], 5.0f);
  EXPECT_FLOAT_EQ(r4[0], 10.0f);

  // Runtime pointer is still the same after all interleaved operations
  EXPECT_EQ(&normalizer_->runtime(), &combiner_->runtime());
}

TEST_F(AddonSharedRuntimeTest, ConcurrentInferenceSharesSingleRuntime) {
  std::vector<float> data = {1.0f, 2.0f, 3.0f, 4.0f};

  auto normFuture = std::async(std::launch::async, [&]() {
    std::vector<float> results;
    for (int i = 0; i < 10; ++i) {
      results = normalizer_->normalize(data);
    }
    return results;
  });

  auto combFuture = std::async(std::launch::async, [&]() {
    std::vector<float> results;
    for (int i = 0; i < 10; ++i) {
      results = combiner_->combine(data, data);
    }
    return results;
  });

  auto normResult = normFuture.get();
  auto combResult = combFuture.get();

  // Verify results are still correct after concurrent execution
  ASSERT_EQ(normResult.size(), 4);
  EXPECT_FLOAT_EQ(normResult[0], 1.0f);
  EXPECT_FLOAT_EQ(normResult[3], 4.0f);

  ASSERT_EQ(combResult.size(), 4);
  EXPECT_FLOAT_EQ(combResult[0], 2.0f);
  EXPECT_FLOAT_EQ(combResult[3], 8.0f);

  // Singleton is still the same instance
  EXPECT_EQ(&normalizer_->runtime(), &combiner_->runtime());
}

// ---------------------------------------------------------------------------
// Test: addons created at different times still share the same runtime
// ---------------------------------------------------------------------------

TEST(AddonSharedRuntimeLifecycleTest, LateCreatedAddonSharesRuntime) {
  auto normalizer = std::make_unique<AddonNormalizer>(
      fixturePath("identity.onnx"));

  // Capture the runtime address before creating the second addon
  const auto* runtimeBefore = &normalizer->runtime();

  auto combiner = std::make_unique<AddonCombiner>(
      fixturePath("add.onnx"));

  EXPECT_EQ(runtimeBefore, &combiner->runtime());
}

TEST(AddonSharedRuntimeLifecycleTest, RuntimeSurvivesAddonDestruction) {
  const oa::OnnxRuntime* runtimeAddr = nullptr;

  {
    AddonNormalizer normalizer(fixturePath("identity.onnx"));
    runtimeAddr = &normalizer.runtime();
  }
  // normalizer is destroyed, but singleton lives on

  AddonCombiner combiner(fixturePath("add.onnx"));
  EXPECT_EQ(runtimeAddr, &combiner.runtime());

  // The combiner still works correctly
  std::vector<float> a = {1.0f, 2.0f, 3.0f, 4.0f};
  std::vector<float> b = {4.0f, 3.0f, 2.0f, 1.0f};
  auto result = combiner.combine(a, b);
  EXPECT_FLOAT_EQ(result[0], 5.0f);
  EXPECT_FLOAT_EQ(result[1], 5.0f);
  EXPECT_FLOAT_EQ(result[2], 5.0f);
  EXPECT_FLOAT_EQ(result[3], 5.0f);
}
