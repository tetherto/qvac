#pragma once

#include <onnxruntime_cxx_api.h>

#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "IOnnxSession.hpp"
#include "OnnxConfig.hpp"
#include "OnnxRuntime.hpp"
#include "OnnxSessionOptionsBuilder.hpp"
#include "OnnxTensor.hpp"
#include "OnnxTypeConversions.hpp"

namespace onnx_addon {

/**
 * Concrete ONNX session implementation (header-only).
 * Inherits from IOnnxSession so that consumers can use virtual dispatch.
 * Requires ONNX Runtime to be linked by the consuming target.
 */
class OnnxSession : public IOnnxSession {
 public:
  // Constructor - loads model from file path
  inline explicit OnnxSession(const std::string& modelPath,
                              const SessionConfig& config = {});

  ~OnnxSession() override = default;

  // Non-copyable
  OnnxSession(const OnnxSession&) = delete;
  OnnxSession& operator=(const OnnxSession&) = delete;

  // Movable
  OnnxSession(OnnxSession&&) noexcept = default;
  OnnxSession& operator=(OnnxSession&&) noexcept = default;

  // Model introspection
  [[nodiscard]] inline std::vector<TensorInfo> getInputInfo() const override;
  [[nodiscard]] inline std::vector<TensorInfo> getOutputInfo() const override;

  // Run inference - single input, all outputs
  inline std::vector<OutputTensor> run(const InputTensor& input) override;

  // Run inference - multiple inputs, all outputs
  inline std::vector<OutputTensor> run(
      const std::vector<InputTensor>& inputs) override;

  // Run inference - multiple inputs, specific outputs
  inline std::vector<OutputTensor> run(
      const std::vector<InputTensor>& inputs,
      const std::vector<std::string>& outputNames) override;

  // Check if session is valid and ready
  [[nodiscard]] inline bool isValid() const override;

  // Get the model path
  [[nodiscard]] inline const std::string& modelPath() const override;

 private:
  std::string modelPath_;
  std::unique_ptr<Ort::Session> session_;
  Ort::AllocatorWithDefaultOptions allocator_;
  std::vector<std::string> inputNames_;
  std::vector<std::string> outputNames_;
};

// ---------------------------------------------------------------------------
// Inline implementation
// ---------------------------------------------------------------------------

inline OnnxSession::OnnxSession(const std::string& modelPath,
                                const SessionConfig& config)
    : modelPath_(modelPath) {
  QLOG(logger::Priority::INFO,
       std::string("[OnnxSession] Loading model: ") + modelPath);

  Ort::SessionOptions sessionOptions = buildSessionOptions(config);

  auto& env = OnnxRuntime::instance().env();

  // Create session
#if defined(_WIN32) || defined(_WIN64)
  // Windows uses wide strings for paths
  std::wstring wideModelPath(modelPath.begin(), modelPath.end());
  session_ =
      std::make_unique<Ort::Session>(env, wideModelPath.c_str(), sessionOptions);
#else
  session_ =
      std::make_unique<Ort::Session>(env, modelPath.c_str(), sessionOptions);
#endif

  // Cache input names
  const size_t numInputs = session_->GetInputCount();
  inputNames_.reserve(numInputs);
  for (size_t i = 0; i < numInputs; ++i) {
    auto namePtr = session_->GetInputNameAllocated(i, allocator_);
    inputNames_.emplace_back(namePtr.get());
  }

  // Cache output names
  const size_t numOutputs = session_->GetOutputCount();
  outputNames_.reserve(numOutputs);
  for (size_t i = 0; i < numOutputs; ++i) {
    auto namePtr = session_->GetOutputNameAllocated(i, allocator_);
    outputNames_.emplace_back(namePtr.get());
  }

  QLOG(logger::Priority::INFO,
       std::string("[OnnxSession] Session created with ") +
           std::to_string(numInputs) + " input(s) and " +
           std::to_string(numOutputs) + " output(s)");
}

inline std::vector<TensorInfo> OnnxSession::getInputInfo() const {
  std::vector<TensorInfo> infos;
  const size_t numInputs = session_->GetInputCount();
  infos.reserve(numInputs);

  for (size_t i = 0; i < numInputs; ++i) {
    TensorInfo info;
    info.name = inputNames_[i];

    auto typeInfo = session_->GetInputTypeInfo(i);
    auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();

    info.shape = tensorInfo.GetShape();
    info.type = fromOnnxType(tensorInfo.GetElementType());

    infos.push_back(std::move(info));
  }

  return infos;
}

inline std::vector<TensorInfo> OnnxSession::getOutputInfo() const {
  std::vector<TensorInfo> infos;
  const size_t numOutputs = session_->GetOutputCount();
  infos.reserve(numOutputs);

  for (size_t i = 0; i < numOutputs; ++i) {
    TensorInfo info;
    info.name = outputNames_[i];

    auto typeInfo = session_->GetOutputTypeInfo(i);
    auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();

    info.shape = tensorInfo.GetShape();
    info.type = fromOnnxType(tensorInfo.GetElementType());

    infos.push_back(std::move(info));
  }

  return infos;
}

inline std::vector<OutputTensor> OnnxSession::run(const InputTensor& input) {
  return run(std::vector<InputTensor>{input});
}

inline std::vector<OutputTensor> OnnxSession::run(
    const std::vector<InputTensor>& inputs) {
  return run(inputs, outputNames_);
}

inline std::vector<OutputTensor> OnnxSession::run(
    const std::vector<InputTensor>& inputs,
    const std::vector<std::string>& outputNames) {
  if (!isValid()) {
    QLOG(logger::Priority::ERROR,
         std::string("[OnnxSession] Run failed: session is not valid for model ") +
             modelPath_);
    throw std::runtime_error("OnnxSession is not valid");
  }
  QLOG(logger::Priority::DEBUG,
       std::string("[OnnxSession] Running inference on ") + modelPath_ +
           " with " + std::to_string(inputs.size()) + " input(s)");

  // Create memory info for CPU
  Ort::MemoryInfo memoryInfo =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

  // Prepare input tensors
  std::vector<Ort::Value> inputTensors;
  inputTensors.reserve(inputs.size());

  std::vector<const char*> inputNamePtrs;
  inputNamePtrs.reserve(inputs.size());

  for (const auto& input : inputs) {
    inputNamePtrs.push_back(input.name.c_str());

    // Create tensor based on type
    switch (input.type) {
      case TensorType::FLOAT32: {
        inputTensors.push_back(Ort::Value::CreateTensor<float>(
            memoryInfo, const_cast<float*>(static_cast<const float*>(input.data)),
            input.dataSize / sizeof(float), input.shape.data(),
            input.shape.size()));
        break;
      }
      case TensorType::INT64: {
        inputTensors.push_back(Ort::Value::CreateTensor<int64_t>(
            memoryInfo,
            const_cast<int64_t*>(static_cast<const int64_t*>(input.data)),
            input.dataSize / sizeof(int64_t), input.shape.data(),
            input.shape.size()));
        break;
      }
      case TensorType::INT32: {
        inputTensors.push_back(Ort::Value::CreateTensor<int32_t>(
            memoryInfo,
            const_cast<int32_t*>(static_cast<const int32_t*>(input.data)),
            input.dataSize / sizeof(int32_t), input.shape.data(),
            input.shape.size()));
        break;
      }
      case TensorType::UINT8: {
        inputTensors.push_back(Ort::Value::CreateTensor<uint8_t>(
            memoryInfo,
            const_cast<uint8_t*>(static_cast<const uint8_t*>(input.data)),
            input.dataSize / sizeof(uint8_t), input.shape.data(),
            input.shape.size()));
        break;
      }
      case TensorType::INT8: {
        inputTensors.push_back(Ort::Value::CreateTensor<int8_t>(
            memoryInfo,
            const_cast<int8_t*>(static_cast<const int8_t*>(input.data)),
            input.dataSize / sizeof(int8_t), input.shape.data(),
            input.shape.size()));
        break;
      }
      default: {
        // Default to float
        inputTensors.push_back(Ort::Value::CreateTensor<float>(
            memoryInfo, const_cast<float*>(static_cast<const float*>(input.data)),
            input.dataSize / sizeof(float), input.shape.data(),
            input.shape.size()));
        break;
      }
    }
  }

  // Prepare output name pointers
  std::vector<const char*> outputNamePtrs;
  outputNamePtrs.reserve(outputNames.size());
  for (const auto& name : outputNames) {
    outputNamePtrs.push_back(name.c_str());
  }

  // Run inference
  auto ortOutputs = session_->Run(
      Ort::RunOptions{nullptr}, inputNamePtrs.data(), inputTensors.data(),
      inputTensors.size(), outputNamePtrs.data(), outputNamePtrs.size());

  // Convert outputs
  std::vector<OutputTensor> outputs;
  outputs.reserve(ortOutputs.size());

  for (size_t i = 0; i < ortOutputs.size(); ++i) {
    OutputTensor output;
    output.name = outputNames[i];

    auto& ortOutput = ortOutputs[i];
    auto typeInfo = ortOutput.GetTypeInfo();
    auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();

    output.shape = tensorInfo.GetShape();
    output.type = fromOnnxType(tensorInfo.GetElementType());

    // Calculate data size and copy
    size_t elementCount = output.elementCount();
    size_t elementSize = tensorTypeSize(output.type);
    size_t dataSize = elementCount * elementSize;

    output.data.resize(dataSize);
    const void* srcData = ortOutput.GetTensorRawData();
    std::memcpy(output.data.data(), srcData, dataSize);

    outputs.push_back(std::move(output));
  }

  return outputs;
}

inline bool OnnxSession::isValid() const {
  return session_ != nullptr;
}

inline const std::string& OnnxSession::modelPath() const {
  return modelPath_;
}

}  // namespace onnx_addon
