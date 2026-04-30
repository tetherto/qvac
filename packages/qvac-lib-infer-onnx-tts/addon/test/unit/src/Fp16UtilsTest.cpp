#include "src/model-interface/Fp16Utils.hpp"
#include <cmath>
#include <gtest/gtest.h>
#include <limits>
#include <vector>

namespace qvac::ttslib::fp16::testing {

using chatterbox::OrtElementType;
using chatterbox::OrtTensor;

class Fp16ConversionTest : public ::testing::Test {};
class TensorReadWriteTest : public ::testing::Test {};

TEST_F(Fp16ConversionTest, positiveZero) {
  uint16_t fp16Zero = 0x0000;
  EXPECT_FLOAT_EQ(toFp32(fp16Zero), 0.0f);
}

TEST_F(Fp16ConversionTest, negativeZero) {
  uint16_t fp16NegZero = 0x8000;
  EXPECT_FLOAT_EQ(toFp32(fp16NegZero), -0.0f);
}

TEST_F(Fp16ConversionTest, one) {
  uint16_t fp16One = 0x3C00;
  EXPECT_FLOAT_EQ(toFp32(fp16One), 1.0f);
}

TEST_F(Fp16ConversionTest, negativeOne) {
  uint16_t fp16NegOne = 0xBC00;
  EXPECT_FLOAT_EQ(toFp32(fp16NegOne), -1.0f);
}

TEST_F(Fp16ConversionTest, half) {
  uint16_t fp16Half = 0x3800;
  EXPECT_FLOAT_EQ(toFp32(fp16Half), 0.5f);
}

TEST_F(Fp16ConversionTest, infinity) {
  uint16_t fp16Inf = 0x7C00;
  EXPECT_TRUE(std::isinf(toFp32(fp16Inf)));
  EXPECT_GT(toFp32(fp16Inf), 0.0f);
}

TEST_F(Fp16ConversionTest, negativeInfinity) {
  uint16_t fp16NegInf = 0xFC00;
  EXPECT_TRUE(std::isinf(toFp32(fp16NegInf)));
  EXPECT_LT(toFp32(fp16NegInf), 0.0f);
}

TEST_F(Fp16ConversionTest, nan) {
  uint16_t fp16Nan = 0x7C01;
  EXPECT_TRUE(std::isnan(toFp32(fp16Nan)));
}

TEST_F(Fp16ConversionTest, subnormalSmallest) {
  uint16_t fp16Subnormal = 0x0001;
  float result = toFp32(fp16Subnormal);
  EXPECT_GT(result, 0.0f);
  EXPECT_LT(result, 1e-6f);
}

TEST_F(Fp16ConversionTest, roundtripPreservesCommonValues) {
  std::vector<float> values = {0.0f,  1.0f, -1.0f, 0.5f,   -0.5f,
                               0.25f, 2.0f, -2.0f, 100.0f, 0.001f};
  for (float original : values) {
    uint16_t fp16 = fromFp32(original);
    float restored = toFp32(fp16);
    EXPECT_NEAR(restored, original, std::abs(original) * 0.01f + 1e-6f)
        << "Roundtrip failed for " << original;
  }
}

TEST_F(Fp16ConversionTest, fromFp32Zero) { EXPECT_EQ(fromFp32(0.0f), 0x0000); }

TEST_F(Fp16ConversionTest, fromFp32One) { EXPECT_EQ(fromFp32(1.0f), 0x3C00); }

TEST_F(Fp16ConversionTest, fromFp32NegativeOne) {
  EXPECT_EQ(fromFp32(-1.0f), 0xBC00);
}

TEST_F(Fp16ConversionTest, fromFp32Infinity) {
  EXPECT_EQ(fromFp32(std::numeric_limits<float>::infinity()), 0x7C00);
}

TEST_F(Fp16ConversionTest, fromFp32Overflow) {
  EXPECT_EQ(fromFp32(100000.0f), 0x7C00);
}

TEST_F(Fp16ConversionTest, fromFp32VerySmallBecomesZero) {
  uint16_t result = fromFp32(1e-10f);
  EXPECT_EQ(result, 0x0000);
}

TEST_F(Fp16ConversionTest, isFp16ReturnsTrueForFp16Tensor) {
  OrtTensor tensor{nullptr, "test", {1, 2}, OrtElementType::Fp16};
  EXPECT_TRUE(isFp16(tensor));
}

TEST_F(Fp16ConversionTest, isFp16ReturnsFalseForFp32Tensor) {
  OrtTensor tensor{nullptr, "test", {1, 2}, OrtElementType::Fp32};
  EXPECT_FALSE(isFp16(tensor));
}

TEST_F(Fp16ConversionTest, isFp16ReturnsFalseForInt64Tensor) {
  OrtTensor tensor{nullptr, "test", {1, 2}, OrtElementType::Int64};
  EXPECT_FALSE(isFp16(tensor));
}

TEST_F(TensorReadWriteTest, getNumElementsEmptyShape) {
  OrtTensor tensor{nullptr, "test", {}, OrtElementType::Fp32};
  EXPECT_EQ(getNumElements(tensor), 0);
}

TEST_F(TensorReadWriteTest, getNumElementsScalar) {
  OrtTensor tensor{nullptr, "test", {1}, OrtElementType::Fp32};
  EXPECT_EQ(getNumElements(tensor), 1);
}

TEST_F(TensorReadWriteTest, getNumElementsMultiDimensional) {
  OrtTensor tensor{nullptr, "test", {2, 3, 4}, OrtElementType::Fp32};
  EXPECT_EQ(getNumElements(tensor), 24);
}

TEST_F(TensorReadWriteTest, readFp32TensorToFloatVector) {
  std::vector<float> data = {1.0f, 2.0f, 3.0f, 4.0f};
  OrtTensor tensor{data.data(), "test", {1, 4}, OrtElementType::Fp32};

  std::vector<float> dest;
  readTensorToFloatVector(tensor, dest, dest.begin());

  ASSERT_EQ(dest.size(), 4u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 2.0f);
  EXPECT_FLOAT_EQ(dest[2], 3.0f);
  EXPECT_FLOAT_EQ(dest[3], 4.0f);
}

TEST_F(TensorReadWriteTest, readFp16TensorToFloatVector) {
  std::vector<uint16_t> fp16Data = {fromFp32(1.0f), fromFp32(2.0f),
                                    fromFp32(3.0f)};
  OrtTensor tensor{fp16Data.data(), "test", {1, 3}, OrtElementType::Fp16};

  std::vector<float> dest;
  readTensorToFloatVector(tensor, dest, dest.begin());

  ASSERT_EQ(dest.size(), 3u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 2.0f);
  EXPECT_FLOAT_EQ(dest[2], 3.0f);
}

TEST_F(TensorReadWriteTest, readFp32TensorToFloatBuffer) {
  std::vector<float> data = {10.0f, 20.0f, 30.0f, 40.0f, 50.0f};
  OrtTensor tensor{data.data(), "test", {1, 5}, OrtElementType::Fp32};

  std::vector<float> dest(3);
  readTensorToFloatBuffer(tensor, dest.data(), 1, 3);

  EXPECT_FLOAT_EQ(dest[0], 20.0f);
  EXPECT_FLOAT_EQ(dest[1], 30.0f);
  EXPECT_FLOAT_EQ(dest[2], 40.0f);
}

TEST_F(TensorReadWriteTest, readFp16TensorToFloatBufferWithOffset) {
  std::vector<uint16_t> fp16Data = {fromFp32(10.0f), fromFp32(20.0f),
                                    fromFp32(30.0f), fromFp32(40.0f)};
  OrtTensor tensor{fp16Data.data(), "test", {1, 4}, OrtElementType::Fp16};

  std::vector<float> dest(2);
  readTensorToFloatBuffer(tensor, dest.data(), 2, 2);

  EXPECT_FLOAT_EQ(dest[0], 30.0f);
  EXPECT_FLOAT_EQ(dest[1], 40.0f);
}

TEST_F(TensorReadWriteTest, writeFloatDataToFp32Tensor) {
  std::vector<float> tensorBuffer(3, 0.0f);
  OrtTensor tensor{tensorBuffer.data(), "test", {1, 3}, OrtElementType::Fp32};

  std::vector<float> src = {5.0f, 10.0f, 15.0f};
  writeFloatDataToTensor(tensor, src.data(), src.size());

  EXPECT_FLOAT_EQ(tensorBuffer[0], 5.0f);
  EXPECT_FLOAT_EQ(tensorBuffer[1], 10.0f);
  EXPECT_FLOAT_EQ(tensorBuffer[2], 15.0f);
}

TEST_F(TensorReadWriteTest, writeFloatDataToFp16Tensor) {
  std::vector<uint16_t> tensorBuffer(3, 0);
  OrtTensor tensor{tensorBuffer.data(), "test", {1, 3}, OrtElementType::Fp16};

  std::vector<float> src = {1.0f, 2.0f, 3.0f};
  writeFloatDataToTensor(tensor, src.data(), src.size());

  EXPECT_FLOAT_EQ(toFp32(tensorBuffer[0]), 1.0f);
  EXPECT_FLOAT_EQ(toFp32(tensorBuffer[1]), 2.0f);
  EXPECT_FLOAT_EQ(toFp32(tensorBuffer[2]), 3.0f);
}

TEST_F(TensorReadWriteTest, fp16RoundtripThroughTensorReadWrite) {
  std::vector<float> original = {0.5f, -0.5f, 1.5f, -1.5f, 0.0f};

  std::vector<uint16_t> fp16Buffer(original.size());
  OrtTensor writeTensor{fp16Buffer.data(),
                        "test",
                        {1, static_cast<int64_t>(original.size())},
                        OrtElementType::Fp16};
  writeFloatDataToTensor(writeTensor, original.data(), original.size());

  OrtTensor readTensor{fp16Buffer.data(),
                       "test",
                       {1, static_cast<int64_t>(original.size())},
                       OrtElementType::Fp16};
  std::vector<float> restored;
  readTensorToFloatVector(readTensor, restored, restored.begin());

  ASSERT_EQ(restored.size(), original.size());
  for (size_t i = 0; i < original.size(); i++) {
    EXPECT_NEAR(restored[i], original[i], 0.01f)
        << "Roundtrip mismatch at index " << i;
  }
}

TEST_F(TensorReadWriteTest, writeSingleFloatToFp16Tensor) {
  uint16_t fp16Value = 0;
  OrtTensor tensor{&fp16Value, "test", {1}, OrtElementType::Fp16};

  float value = 0.5f;
  writeFloatDataToTensor(tensor, &value, 1);

  EXPECT_FLOAT_EQ(toFp32(fp16Value), 0.5f);
}

} // namespace qvac::ttslib::fp16::testing
