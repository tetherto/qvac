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

TEST(OnnxInferSessionMockTest, setOutputToInputChainIsInvokedWithMapping) {
  OnnxInferSessionMock mock;
  std::vector<std::pair<std::string, std::string>> mapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
  };
  EXPECT_CALL(mock, setOutputToInputChain(::testing::Eq(mapping))).Times(1);
  mock.setOutputToInputChain(mapping);
}

TEST(OnnxInferSessionMockTest, clearChainedInputsIsInvoked) {
  OnnxInferSessionMock mock;
  EXPECT_CALL(mock, clearChainedInputs()).Times(1);
  mock.clearChainedInputs();
}

TEST(OnnxInferSessionMockTest, isInputChainedReturnsConfiguredValue) {
  OnnxInferSessionMock mock;
  EXPECT_CALL(mock, isInputChained("past_key_values.0.key"))
      .WillOnce(::testing::Return(true));
  EXPECT_CALL(mock, isInputChained("attention_mask"))
      .WillOnce(::testing::Return(false));
  EXPECT_TRUE(mock.isInputChained("past_key_values.0.key"));
  EXPECT_FALSE(mock.isInputChained("attention_mask"));
}

} // namespace qvac::ttslib::chatterbox::testing
