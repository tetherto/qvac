#include "src/model-interface/TensorFloatHandler.hpp"
#include "src/model-interface/Fp16Utils.hpp"
#include <gtest/gtest.h>
#include <vector>

namespace qvac::ttslib::tensor_float::testing {

using chatterbox::OrtElementType;
using chatterbox::OrtTensor;

class TensorFloatHandlerFactoryTest : public ::testing::Test {};
class Int4HandlerTest : public ::testing::Test {};
class UInt4HandlerTest : public ::testing::Test {};

TEST_F(TensorFloatHandlerFactoryTest, getReturnsFp32HandlerForFp32) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Fp32);
  std::vector<float> data = {1.0f, 2.0f};
  OrtTensor tensor{data.data(), "t", {1, 2}, OrtElementType::Fp32};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 2u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 2.0f);
}

TEST_F(TensorFloatHandlerFactoryTest, getReturnsFp16HandlerForFp16) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Fp16);
  std::vector<uint16_t> data = {fp16::fromFp32(1.0f), fp16::fromFp32(2.0f)};
  OrtTensor tensor{data.data(), "t", {1, 2}, OrtElementType::Fp16};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 2u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 2.0f);
}

TEST_F(TensorFloatHandlerFactoryTest, getReturnsInt4HandlerForInt4) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Int4);
  uint8_t packed = 0x21;
  OrtTensor tensor{&packed, "t", {1, 2}, OrtElementType::Int4};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 2u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 2.0f);
}

TEST_F(TensorFloatHandlerFactoryTest, getReturnsUInt4HandlerForUInt4) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::UInt4);
  uint8_t packed = 0x21;
  OrtTensor tensor{&packed, "t", {1, 2}, OrtElementType::UInt4};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 2u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 2.0f);
}

TEST_F(TensorFloatHandlerFactoryTest, getReturnsFp32HandlerForUnknownType) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Int64);
  std::vector<float> data = {3.0f};
  OrtTensor tensor{data.data(), "t", {1}, OrtElementType::Fp32};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 1u);
  EXPECT_FLOAT_EQ(dest[0], 3.0f);
}

TEST_F(Int4HandlerTest, readToVectorPackedNibbles) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Int4);
  uint8_t packed[] = {0xFE, 0x07};
  OrtTensor tensor{packed, "t", {1, 4}, OrtElementType::Int4};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 4u);
  EXPECT_FLOAT_EQ(dest[0], -2.0f);
  EXPECT_FLOAT_EQ(dest[1], -1.0f);
  EXPECT_FLOAT_EQ(dest[2], 7.0f);
  EXPECT_FLOAT_EQ(dest[3], 0.0f);
}

TEST_F(Int4HandlerTest, readToBufferWithOffset) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Int4);
  uint8_t packed[] = {0x10, 0x32, 0x54};
  OrtTensor tensor{packed, "t", {1, 6}, OrtElementType::Int4};
  std::vector<float> dest(2);
  h.readToBuffer(tensor, dest.data(), 2, 2);
  EXPECT_FLOAT_EQ(dest[0], 2.0f);
  EXPECT_FLOAT_EQ(dest[1], 3.0f);
}

TEST_F(Int4HandlerTest, writeFromFloatPacksNibbles) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::Int4);
  uint8_t buffer[2] = {0, 0};
  OrtTensor tensor{buffer, "t", {1, 4}, OrtElementType::Int4};
  float src[] = {-8.0f, 7.0f, 0.0f, -1.0f};
  h.writeFromFloat(tensor, src, 4);
  EXPECT_EQ(buffer[0], 0x78u);
  EXPECT_EQ(buffer[1], 0xF0u);
}

TEST_F(Int4HandlerTest, int4RoundtripThroughFp16Utils) {
  std::vector<float> original = {-8.0f, -4.0f, 0.0f, 4.0f, 7.0f};
  size_t numBytes = (original.size() + 1) / 2;
  std::vector<uint8_t> packed(numBytes, 0);
  OrtTensor writeTensor{packed.data(),
                        "t",
                        {1, static_cast<int64_t>(original.size())},
                        OrtElementType::Int4};
  fp16::writeFloatDataToTensor(writeTensor, original.data(), original.size());

  OrtTensor readTensor{packed.data(),
                       "t",
                       {1, static_cast<int64_t>(original.size())},
                       OrtElementType::Int4};
  std::vector<float> restored;
  fp16::readTensorToFloatVector(readTensor, restored, restored.begin());

  ASSERT_EQ(restored.size(), original.size());
  for (size_t i = 0; i < original.size(); i++) {
    EXPECT_FLOAT_EQ(restored[i], original[i]) << "at index " << i;
  }
}

TEST_F(UInt4HandlerTest, readToVectorPackedNibbles) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::UInt4);
  uint8_t packed[] = {0x01, 0xFE};
  OrtTensor tensor{packed, "t", {1, 4}, OrtElementType::UInt4};
  std::vector<float> dest;
  h.readToVector(tensor, dest, dest.begin());
  ASSERT_EQ(dest.size(), 4u);
  EXPECT_FLOAT_EQ(dest[0], 1.0f);
  EXPECT_FLOAT_EQ(dest[1], 0.0f);
  EXPECT_FLOAT_EQ(dest[2], 14.0f);
  EXPECT_FLOAT_EQ(dest[3], 15.0f);
}

TEST_F(UInt4HandlerTest, writeFromFloatPacksNibbles) {
  const auto &h = TensorFloatHandlerFactory::get(OrtElementType::UInt4);
  uint8_t buffer[2] = {0, 0};
  OrtTensor tensor{buffer, "t", {1, 4}, OrtElementType::UInt4};
  float src[] = {0.0f, 15.0f, 8.0f, 1.0f};
  h.writeFromFloat(tensor, src, 4);
  EXPECT_EQ(buffer[0], 0xF0u);
  EXPECT_EQ(buffer[1], 0x18u);
}

TEST_F(UInt4HandlerTest, uint4RoundtripThroughFp16Utils) {
  std::vector<float> original = {0.0f, 5.0f, 10.0f, 15.0f};
  size_t numBytes = (original.size() + 1) / 2;
  std::vector<uint8_t> packed(numBytes, 0);
  OrtTensor writeTensor{packed.data(),
                        "t",
                        {1, static_cast<int64_t>(original.size())},
                        OrtElementType::UInt4};
  fp16::writeFloatDataToTensor(writeTensor, original.data(), original.size());

  OrtTensor readTensor{packed.data(),
                       "t",
                       {1, static_cast<int64_t>(original.size())},
                       OrtElementType::UInt4};
  std::vector<float> restored;
  fp16::readTensorToFloatVector(readTensor, restored, restored.begin());

  ASSERT_EQ(restored.size(), original.size());
  for (size_t i = 0; i < original.size(); i++) {
    EXPECT_FLOAT_EQ(restored[i], original[i]) << "at index " << i;
  }
}

} // namespace qvac::ttslib::tensor_float::testing
