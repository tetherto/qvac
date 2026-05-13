#include <gtest/gtest.h>

#include "qvac-onnx/OnnxTypeConversions.hpp"

namespace oa = onnx_addon;

TEST(TypeConversionsTest, ToOnnxTypeFloat32) {
  EXPECT_EQ(oa::toOnnxType(oa::TensorType::FLOAT32), ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT);
}

TEST(TypeConversionsTest, ToOnnxTypeFloat16) {
  EXPECT_EQ(oa::toOnnxType(oa::TensorType::FLOAT16),
            ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16);
}

TEST(TypeConversionsTest, ToOnnxTypeInt64) {
  EXPECT_EQ(oa::toOnnxType(oa::TensorType::INT64), ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64);
}

TEST(TypeConversionsTest, ToOnnxTypeInt32) {
  EXPECT_EQ(oa::toOnnxType(oa::TensorType::INT32), ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32);
}

TEST(TypeConversionsTest, ToOnnxTypeInt8) {
  EXPECT_EQ(oa::toOnnxType(oa::TensorType::INT8), ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8);
}

TEST(TypeConversionsTest, ToOnnxTypeUint8) {
  EXPECT_EQ(oa::toOnnxType(oa::TensorType::UINT8), ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8);
}

TEST(TypeConversionsTest, FromOnnxTypeFloat) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT),
            oa::TensorType::FLOAT32);
}

TEST(TypeConversionsTest, FromOnnxTypeFloat16) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16),
            oa::TensorType::FLOAT16);
}

TEST(TypeConversionsTest, FromOnnxTypeInt64) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64),
            oa::TensorType::INT64);
}

TEST(TypeConversionsTest, FromOnnxTypeInt32) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32),
            oa::TensorType::INT32);
}

TEST(TypeConversionsTest, FromOnnxTypeInt8) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8), oa::TensorType::INT8);
}

TEST(TypeConversionsTest, FromOnnxTypeUint8) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8),
            oa::TensorType::UINT8);
}

TEST(TypeConversionsTest, FromOnnxTypeUnknownDefaultsToFloat32) {
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_DOUBLE),
            oa::TensorType::FLOAT32);
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_STRING),
            oa::TensorType::FLOAT32);
  EXPECT_EQ(oa::fromOnnxType(ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL),
            oa::TensorType::FLOAT32);
}

TEST(TypeConversionsTest, RoundTripAllTypes) {
  // Verify that toOnnxType -> fromOnnxType is identity for all supported types
  EXPECT_EQ(oa::fromOnnxType(oa::toOnnxType(oa::TensorType::FLOAT32)), oa::TensorType::FLOAT32);
  EXPECT_EQ(oa::fromOnnxType(oa::toOnnxType(oa::TensorType::FLOAT16)), oa::TensorType::FLOAT16);
  EXPECT_EQ(oa::fromOnnxType(oa::toOnnxType(oa::TensorType::INT64)), oa::TensorType::INT64);
  EXPECT_EQ(oa::fromOnnxType(oa::toOnnxType(oa::TensorType::INT32)), oa::TensorType::INT32);
  EXPECT_EQ(oa::fromOnnxType(oa::toOnnxType(oa::TensorType::INT8)), oa::TensorType::INT8);
  EXPECT_EQ(oa::fromOnnxType(oa::toOnnxType(oa::TensorType::UINT8)), oa::TensorType::UINT8);
}
