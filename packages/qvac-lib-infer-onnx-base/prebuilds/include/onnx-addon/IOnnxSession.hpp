#pragma once

#include <string>
#include <vector>

#include "OnnxTensor.hpp"

namespace onnx_addon {

/**
 * Abstract interface for ONNX sessions.
 * Other addons should use this interface (via virtual methods) to avoid
 * direct symbol dependencies on the ONNX addon.
 */
class IOnnxSession {
 public:
  virtual ~IOnnxSession() = default;

  // Model introspection
  [[nodiscard]] virtual std::vector<TensorInfo> getInputInfo() const = 0;
  [[nodiscard]] virtual std::vector<TensorInfo> getOutputInfo() const = 0;

  // Run inference - single input, all outputs
  virtual std::vector<OutputTensor> run(const InputTensor& input) = 0;

  // Run inference - multiple inputs, all outputs
  virtual std::vector<OutputTensor> run(const std::vector<InputTensor>& inputs) = 0;

  // Run inference - multiple inputs, specific outputs
  virtual std::vector<OutputTensor> run(const std::vector<InputTensor>& inputs,
                                        const std::vector<std::string>& outputNames) = 0;

  // Check if session is valid and ready
  [[nodiscard]] virtual bool isValid() const = 0;

  // Get the model path
  [[nodiscard]] virtual const std::string& modelPath() const = 0;
};

}  // namespace onnx_addon
