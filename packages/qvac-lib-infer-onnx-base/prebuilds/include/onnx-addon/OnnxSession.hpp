#pragma once

#include <memory>
#include <string>
#include <vector>

#include "IOnnxSession.hpp"
#include "OnnxConfig.hpp"
#include "OnnxTensor.hpp"

namespace onnx_addon {

/**
 * Concrete ONNX session implementation.
 * Inherits from IOnnxSession so that other addons can use virtual dispatch
 * without needing to link against this addon.
 */
class OnnxSession : public IOnnxSession {
 public:
  // Constructor - loads model from file path
  explicit OnnxSession(const std::string& modelPath,
                       const SessionConfig& config = {});

  // Destructor
  ~OnnxSession() override;

  // Non-copyable
  OnnxSession(const OnnxSession&) = delete;
  OnnxSession& operator=(const OnnxSession&) = delete;

  // Movable
  OnnxSession(OnnxSession&&) noexcept;
  OnnxSession& operator=(OnnxSession&&) noexcept;

  // Model introspection (virtual from IOnnxSession)
  [[nodiscard]] std::vector<TensorInfo> getInputInfo() const override;
  [[nodiscard]] std::vector<TensorInfo> getOutputInfo() const override;

  // Run inference - single input, all outputs (virtual from IOnnxSession)
  std::vector<OutputTensor> run(const InputTensor& input) override;

  // Run inference - multiple inputs, all outputs (virtual from IOnnxSession)
  std::vector<OutputTensor> run(const std::vector<InputTensor>& inputs) override;

  // Run inference - multiple inputs, specific outputs (virtual from IOnnxSession)
  std::vector<OutputTensor> run(const std::vector<InputTensor>& inputs,
                                const std::vector<std::string>& outputNames) override;

  // Check if session is valid and ready (virtual from IOnnxSession)
  [[nodiscard]] bool isValid() const override;

  // Get the model path (virtual from IOnnxSession)
  [[nodiscard]] const std::string& modelPath() const override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace onnx_addon
