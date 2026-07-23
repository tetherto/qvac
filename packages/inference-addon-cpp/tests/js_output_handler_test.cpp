#include <any>
#include <span>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "helpers_header/js.h"
#include "inference-addon-cpp/JsUtils.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp"
#include "inference-addon-cpp/job/JobId.hpp"
#include "inference-addon-cpp/queue/OutputCallbackInterface.hpp"
#include "inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

// ============================================================================
// Minimal stubs needed for OutputQueue instantiation in JS test context
// ============================================================================

class MockJsModel : public model::IModel {
public:
  std::string getName() const override { return "MockJsModel"; }
  RuntimeStats runtimeStats() const override { return {}; }
  std::any process(const std::any& /*input*/) override { return {}; }
};

class NoopJsCallback : public OutputCallBackInterface {
public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*q*/) override {}
  void notify() override {}
  void stop() override {}
};

/// @brief Simple 2D array stored as flattened data for testing.
template <typename T> class Flattened2DArray {
private:
  std::vector<T> flat_data_;
  std::size_t row_count_ = 0;
  std::size_t row_size_ = 0;

public:
  Flattened2DArray(
      std::vector<T> flatData, std::size_t rowCount, std::size_t rowSize)
      : flat_data_(std::move(flatData)), row_count_(rowCount),
        row_size_(rowSize) {}

  std::span<const T> operator[](std::size_t index) const {
    const std::size_t offset = index * row_size_;
    return std::span<const T>(flat_data_.data() + offset, row_size_);
  }

  [[nodiscard]] std::size_t size() const { return row_count_; }
};

// ============================================================================
// JsStringOutputHandler Tests
// ============================================================================

TEST(JsOutputHandlerTest, JsStringOutputHandlerCanInstantiate) {
  js_env_t env;
  out_handl::JsStringOutputHandler handler;
  handler.setEnv(&env);
  EXPECT_TRUE(true);
}

TEST(JsOutputHandlerTest, JsStringOutputHandlerCanHandleString) {
  js_env_t env;
  out_handl::JsStringOutputHandler handler;
  handler.setEnv(&env);

  std::string testString = "test string";
  std::any testData = std::any(testString);

  EXPECT_TRUE(handler.canHandle(testData));
}

// ============================================================================
// JsTypedArrayOutputHandler Tests
// ============================================================================

TEST(JsOutputHandlerTest, JsTypedArrayOutputHandlerCanInstantiate) {
  js_env_t env;
  out_handl::JsTypedArrayOutputHandler<float> handler;
  handler.setEnv(&env);
  EXPECT_TRUE(true);
}

TEST(JsOutputHandlerTest, JsTypedArrayOutputHandlerCanHandleVector) {
  js_env_t env;
  out_handl::JsTypedArrayOutputHandler<float> handler;
  handler.setEnv(&env);

  std::vector<float> testData = {1.0f, 2.0f, 3.0f, 4.0f};
  std::any testAny = std::any(testData);

  EXPECT_TRUE(handler.canHandle(testAny));
}

// ============================================================================
// Js2DArrayOutputHandler Tests
// ============================================================================

TEST(JsOutputHandlerTest, Js2DArrayOutputHandlerCanInstantiate) {
  js_env_t env;
  out_handl::Js2DArrayOutputHandler<Flattened2DArray<float>, float> handler;
  handler.setEnv(&env);
  EXPECT_TRUE(true);
}

TEST(JsOutputHandlerTest, Js2DArrayOutputHandlerCanHandleFlattened2DArray) {
  js_env_t env;
  out_handl::Js2DArrayOutputHandler<Flattened2DArray<float>, float> handler;
  handler.setEnv(&env);

  std::vector<float> flatData = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f};
  Flattened2DArray<float> array(std::move(flatData), 2, 3);

  std::any testData = std::any(array);

  EXPECT_TRUE(handler.canHandle(testData));
}

// ============================================================================
// JsStringOutputHandler Tests
// ============================================================================

TEST(JsOutputHandlerTest, JsStringArrayOutputHandlerCanInstantiate) {
  js_env_t env;
  out_handl::JsStringArrayOutputHandler handler;
  handler.setEnv(&env);
  EXPECT_TRUE(true);
}

TEST(JsOutputHandlerTest, JsStringArrayOutputHandlerCanHandleString) {
  js_env_t env;
  out_handl::JsStringArrayOutputHandler handler;
  handler.setEnv(&env);

  std::vector<std::string> testString = {
      "test string", "test string 2", "hello world"};
  std::any testData = std::any(testString);

  EXPECT_TRUE(handler.canHandle(testData));
}


// ============================================================================
// JS 5th-arg contract — id-tag correctness that drives outputCbParameters[4]
//
// OutputCallbackJs sets param[4] via:
//   (id == kNoJobId) ? js::Undefined::create(env) : js::Number::create(env, id)
//
// These tests verify that the underlying OutputQueue entries carry the right id
// so that jsOutputCallback will produce the correct 5th argument.
// ============================================================================

/// (c) Existing single-arg queueResult still produces kNoJobId — 5th arg will
///     be js::Undefined, preserving the pre-multi-job callback contract.
TEST(JsOutputCbIdTest, NoIdOverloadProducesKNoJobId) {
  NoopJsCallback cb;
  MockJsModel model;
  OutputQueue queue(cb, model);

  queue.queueResult(std::any(std::string("msg")));

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, kNoJobId);
}

/// (a) Real JobId is preserved through the queue so jsOutputCallback can pass
///     it as a JS number in outputCbParameters[4].
TEST(JsOutputCbIdTest, RealJobIdPreservedForJsNumberParam) {
  NoopJsCallback cb;
  MockJsModel model;
  OutputQueue queue(cb, model);

  const JobId id = 55;
  queue.queueResult(std::any(std::string("tagged")), id);

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, id);
}

/// (b) kNoJobId sentinel triggers the undefined branch in param[4].
///     Verifies the exact value used by createOutputCbParams.
TEST(JsOutputCbIdTest, KNoJobIdSentinelMatchesConstant) {
  static_assert(
      kNoJobId == 0,
      "kNoJobId must be 0; OutputCallbackJs equality check assumes this");
  EXPECT_EQ(kNoJobId, JobId{0});
}

/// Explicit round-trip: js::Undefined::create succeeds (mock allocates) for the
/// kNoJobId branch, confirming the mock env supports the param[4] code path.
TEST(JsOutputCbIdTest, UndefinedCreateSucceedsForKNoJobIdBranch) {
  js_env_t env;
  const JobId id = kNoJobId;
  /// Replicates the param[4] selection expression from createOutputCbParams.
  js_value_t* param4 = (id == kNoJobId)
      ? static_cast<js_value_t*>(js::Undefined::create(&env))
      : static_cast<js_value_t*>(js::Number::create(&env, id));
  /// js_get_undefined (mock) allocates a js_value_t — pointer must be non-null.
  EXPECT_NE(param4, nullptr);
  delete param4;
}

/// queueException with a real id tags the error entry so param[4] will be a
/// JS number, not undefined.
TEST(JsOutputCbIdTest, ExceptionWithRealIdProducesNonNoJobId) {
  NoopJsCallback cb;
  MockJsModel model;
  OutputQueue queue(cb, model);

  const JobId id = 77;
  const std::runtime_error err("fail");
  queue.queueException(err, id);

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_NE(entries[0].first, kNoJobId);
  EXPECT_EQ(entries[0].first, id);
}

} // namespace qvac_lib_inference_addon_cpp
