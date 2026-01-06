#include <span>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "helpers_header/js.h"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp"

namespace qvac_lib_inference_addon_cpp {

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

} // namespace qvac_lib_inference_addon_cpp
