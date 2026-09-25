#include <ggml.h>
#include <gtest/gtest.h>

#include "model-interface/easyocr/tensor_validation.hpp"

namespace {

ggml_tensor detectionTensor() {
  ggml_tensor tensor{};
  tensor.type = GGML_TYPE_F32;
  tensor.ne[0] = 2;
  tensor.ne[1] = 10;
  tensor.ne[2] = 10;
  tensor.ne[3] = 1;
  return tensor;
}

TEST(OcrTensorValidation, RejectsDetectionChannelMismatchBeforeCopy) {
  auto tensor = detectionTensor();
  tensor.ne[0] = 16;
  EXPECT_THROW(easyocr::ggml::validate_detection_tensor(tensor, 6400),
               std::runtime_error);
}

TEST(OcrTensorValidation, RejectsDetectionCopyLargerThanBuffer) {
  const auto tensor = detectionTensor();
  EXPECT_THROW(easyocr::ggml::validate_detection_tensor(tensor, 6400),
               std::runtime_error);
  EXPECT_NO_THROW(easyocr::ggml::validate_detection_tensor(tensor, 800));
}

TEST(OcrTensorValidation, RejectsVocabularyOverread) {
  EXPECT_THROW(easyocr::ggml::validate_vocab_index(35, 34),
               std::runtime_error);
  EXPECT_NO_THROW(easyocr::ggml::validate_vocab_index(33, 34));
}

TEST(OcrTensorValidation, RejectsShortBiasTensor) {
  EXPECT_FALSE(easyocr::ggml::bias_tensor_size_matches(2, 64));
  EXPECT_TRUE(easyocr::ggml::bias_tensor_size_matches(64, 64));
}

}
