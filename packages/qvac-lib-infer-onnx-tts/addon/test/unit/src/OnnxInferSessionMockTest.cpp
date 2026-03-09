#include "mocks/OnnxInferSessionMock.hpp"
#include "src/model-interface/OrtTypes.hpp"
#include <gtest/gtest.h>
#include <string>
#include <vector>

namespace qvac::ttslib::chatterbox::testing {

TEST(OnnxInferSessionMockTest, runIsInvoked) {
  OnnxInferSessionMock mock;
  EXPECT_CALL(mock, run()).Times(1);
  mock.run();
}

TEST(OnnxInferSessionMockTest, getInputNamesReturnsEmptyByDefault) {
  OnnxInferSessionMock mock;
  EXPECT_CALL(mock, getInputNames())
      .WillOnce(::testing::Return(std::vector<std::string>{}));
  std::vector<std::string> names = mock.getInputNames();
  EXPECT_TRUE(names.empty());
}

TEST(OnnxInferSessionMockTest, getOutputReturnsTensorWithGivenShape) {
  OnnxInferSessionMock mock;
  OrtTensor expected{nullptr, "out", {1, 2, 3}, OrtElementType::Fp32};
  EXPECT_CALL(mock, getOutput("logits")).WillOnce(::testing::Return(expected));
  OrtTensor result = mock.getOutput("logits");
  EXPECT_EQ(result.name, "out");
  EXPECT_EQ(result.shape, std::vector<int64_t>({1, 2, 3}));
  EXPECT_EQ(result.type, OrtElementType::Fp32);
}

TEST(OnnxInferSessionMockTest, initInputTensorsIsInvokedWithShapes) {
  OnnxInferSessionMock mock;
  std::vector<std::vector<int64_t>> shapes = {{1, 10}, {1, 20}};
  EXPECT_CALL(mock, initInputTensors(::testing::Eq(shapes))).Times(1);
  mock.initInputTensors(shapes);
}

} // namespace qvac::ttslib::chatterbox::testing
