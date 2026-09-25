#include <filesystem>
#include <string>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/easyocr/gguf_loader.hpp"
#include "model-interface/easyocr/tensor_validation.hpp"

namespace {

constexpr int64_t kClassCount = 32;

void writePredictionBias(const std::string &path, bool malformed) {
  ggml_init_params params{
      .mem_size = 1024 * 1024, .mem_buffer = nullptr, .no_alloc = false};
  auto *context = ggml_init(params);
  auto *bias = malformed
                   ? ggml_new_tensor_2d(context, GGML_TYPE_F32, kClassCount, 2)
                   : ggml_new_tensor_1d(context, GGML_TYPE_F32, kClassCount);
  ggml_set_name(bias, "Prediction.bias");
  auto *gguf = gguf_init_empty();
  gguf_add_tensor(gguf, bias);
  gguf_write_to_file(gguf, path.c_str(), false);
  gguf_free(gguf);
  ggml_free(context);
}

TEST(OcrPredictionBiasGguf, RejectsExtraBiasDimension) {
  const auto path = std::filesystem::temp_directory_path() /
                    "ocr_prediction_bias_malformed.gguf";
  writePredictionBias(path.string(), true);
  {
    easyocr::ggml::GgufLoader loader(path.string());
    ASSERT_TRUE(loader.ok());
    const auto *bias = loader.get_tensor("Prediction.bias");
    ASSERT_NE(bias, nullptr);
    EXPECT_FALSE(easyocr::ggml::prediction_bias_matches(*bias, kClassCount));
  }
  std::filesystem::remove(path);
}

TEST(OcrPredictionBiasGguf, AcceptsVectorBias) {
  const auto path = std::filesystem::temp_directory_path() /
                    "ocr_prediction_bias_vector.gguf";
  writePredictionBias(path.string(), false);
  {
    easyocr::ggml::GgufLoader loader(path.string());
    ASSERT_TRUE(loader.ok());
    const auto *bias = loader.get_tensor("Prediction.bias");
    ASSERT_NE(bias, nullptr);
    EXPECT_TRUE(easyocr::ggml::prediction_bias_matches(*bias, kClassCount));
  }
  std::filesystem::remove(path);
}

}
