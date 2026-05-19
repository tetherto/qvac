#pragma once

#include "OrtTypes.hpp"

#include <memory>
#include <string>
#include <utility>
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

  // Configure automatic output->input chaining for autoregressive loops.
  // After each run(), for every {outputName, inputName} pair in `mapping`, the
  // output tensor is moved into the input slot for the next run() without
  // copying its data. Matching inputs are preserved across initInputTensors()
  // calls (their shapes/data pointers follow the moved tensor). Call once per
  // generation; use clearChainedInputs() to release state between generations.
  // Throws std::runtime_error if any name in `mapping` is not a known input
  // or output of the session.
  virtual void setOutputToInputChain(
      const std::vector<std::pair<std::string, std::string>> &mapping) = 0;

  // Clears the chaining mapping and releases any input tensors held via
  // chaining. Safe to call even when no chaining is active.
  virtual void clearChainedInputs() = 0;

  // Returns true if `inputName` is currently populated by chaining (so the
  // caller must not rewrite its data with writeFloatDataToTensor / memcpy).
  virtual bool isInputChained(const std::string &inputName) const = 0;
};

} // namespace qvac::ttslib::chatterbox
