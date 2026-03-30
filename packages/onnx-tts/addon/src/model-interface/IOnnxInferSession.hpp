#pragma once

#include "OrtTypes.hpp"

#include <memory>
#include <string>
#include <vector>

namespace qvac::ttslib::chatterbox {

class IOnnxInferSession {
public:
  virtual ~IOnnxInferSession() = default;

  virtual void run() = 0;

  virtual std::vector<std::string> getInputNames() const = 0;
  virtual std::vector<std::string> getOutputNames() const = 0;

  virtual OrtTensor getInput(const std::string &inputName) = 0;
  virtual OrtTensor getOutput(const std::string &outputName) = 0;

  virtual void
  initInputTensors(const std::vector<std::vector<int64_t>> &inputShapes) = 0;
};

} // namespace qvac::ttslib::chatterbox
