#include "pipeline/Steps.hpp"

#include <stdexcept>
#include <string>

#include <gtest/gtest.h>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

// ---------------------------------------------------------------------------
// CancelledException – basic exception semantics
// ---------------------------------------------------------------------------

TEST(CancelledException, IsRuntimeError) {
  CancelledException ex;
  // Must be catchable as std::runtime_error so existing generic handlers work
  EXPECT_NO_THROW({
    try {
      throw CancelledException{};
    } catch (const std::runtime_error&) {
      // expected
    }
  });
}

TEST(CancelledException, MessageIsNotEmpty) {
  CancelledException ex;
  EXPECT_FALSE(std::string(ex.what()).empty());
}

TEST(CancelledException, MessageContainsCancelled) {
  CancelledException ex;
  const std::string msg = ex.what();
  EXPECT_NE(msg.find("cancel"), std::string::npos)
      << "CancelledException message should mention 'cancel', got: " << msg;
}


} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
