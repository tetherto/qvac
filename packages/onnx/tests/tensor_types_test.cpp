#include <gtest/gtest.h>

#include "qvac-onnx/OnnxTensor.hpp"

using namespace onnx_addon;

TEST(TensorTypeTest, TensorTypeSizes) {
  EXPECT_EQ(tensorTypeSize(TensorType::FLOAT32), 4);
  EXPECT_EQ(tensorTypeSize(TensorType::FLOAT16), 2);
  EXPECT_EQ(tensorTypeSize(TensorType::INT64), 8);
  EXPECT_EQ(tensorTypeSize(TensorType::INT32), 4);
  EXPECT_EQ(tensorTypeSize(TensorType::INT8), 1);
  EXPECT_EQ(tensorTypeSize(TensorType::UINT8), 1);
}

TEST(OutputTensorTest, ElementCount) {
  OutputTensor tensor;
  tensor.shape = {2, 3, 4};
  tensor.type = TensorType::FLOAT32;
  EXPECT_EQ(tensor.elementCount(), 24);
}

TEST(OutputTensorTest, ElementCountScalar) {
  OutputTensor tensor;
  tensor.shape = {1};
  tensor.type = TensorType::FLOAT32;
  EXPECT_EQ(tensor.elementCount(), 1);
}

TEST(OutputTensorTest, ElementCountEmpty) {
  OutputTensor tensor;
  tensor.type = TensorType::FLOAT32;
  EXPECT_EQ(tensor.elementCount(), 0);
}

TEST(OutputTensorTest, TypedAccess) {
  OutputTensor tensor;
  tensor.shape = {2};
  tensor.type = TensorType::FLOAT32;
  tensor.data.resize(2 * sizeof(float));

  float* ptr = tensor.asMutable<float>();
  ptr[0] = 1.0f;
  ptr[1] = 2.0f;

  const auto& constTensor = tensor;
  EXPECT_FLOAT_EQ(constTensor.as<float>()[0], 1.0f);
  EXPECT_FLOAT_EQ(constTensor.as<float>()[1], 2.0f);
}

TEST(OutputTensorTest, Int64TypedAccess) {
  OutputTensor tensor;
  tensor.shape = {3};
  tensor.type = TensorType::INT64;
  tensor.data.resize(3 * sizeof(int64_t));

  int64_t* ptr = tensor.asMutable<int64_t>();
  ptr[0] = 100;
  ptr[1] = 200;
  ptr[2] = 300;

  EXPECT_EQ(tensor.as<int64_t>()[0], 100);
  EXPECT_EQ(tensor.as<int64_t>()[1], 200);
  EXPECT_EQ(tensor.as<int64_t>()[2], 300);
}

TEST(InputTensorTest, Defaults) {
  InputTensor input;
  EXPECT_EQ(input.type, TensorType::FLOAT32);
  EXPECT_EQ(input.data, nullptr);
  EXPECT_EQ(input.dataSize, 0);
  EXPECT_TRUE(input.name.empty());
  EXPECT_TRUE(input.shape.empty());
}

TEST(TensorInfoTest, Construction) {
  TensorInfo info;
  info.name = "input_0";
  info.shape = {1, 3, 224, 224};
  info.type = TensorType::FLOAT32;

  EXPECT_EQ(info.name, "input_0");
  EXPECT_EQ(info.shape.size(), 4);
  EXPECT_EQ(info.shape[0], 1);
  EXPECT_EQ(info.shape[3], 224);
  EXPECT_EQ(info.type, TensorType::FLOAT32);
}
