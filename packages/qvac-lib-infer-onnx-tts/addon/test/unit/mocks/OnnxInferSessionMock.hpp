#pragma once

#include "src/model-interface/IOnnxInferSession.hpp"
#include "src/model-interface/OrtTypes.hpp"
#include <gmock/gmock.h>

namespace qvac::ttslib::chatterbox::testing {

class OnnxInferSessionMock : public IOnnxInferSession {
public:
  ~OnnxInferSessionMock() override = default;

  MOCK_METHOD(void, run, (), (override));

  MOCK_METHOD(std::vector<std::string>, getInputNames, (), (const, override));
  MOCK_METHOD(std::vector<std::string>, getOutputNames, (), (const, override));

  MOCK_METHOD(OrtTensor, getInput, (const std::string &inputName), (override));
  MOCK_METHOD(OrtTensor, getOutput, (const std::string &outputName),
              (override));

  MOCK_METHOD(void, initInputTensors,
              (const std::vector<std::vector<int64_t>> &inputShapes),
              (override));
};

} // namespace qvac::ttslib::chatterbox::testing
