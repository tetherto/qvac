#pragma once

#include <onnxruntime_cxx_api.h>

#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "AndroidLog.hpp"
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

  // Direct access to cached input/output names (avoids ORT API queries)
  [[nodiscard]] inline const std::string &
  inputName(size_t index) const override;
  [[nodiscard]] inline const std::string &
  outputName(size_t index) const override;

  // Run inference - single input, all outputs
  inline std::vector<OutputTensor> run(const InputTensor& input) override;

  // Run inference - multiple inputs, all outputs
  inline std::vector<OutputTensor> run(
      const std::vector<InputTensor>& inputs) override;

  // Run inference - multiple inputs, specific outputs
  inline std::vector<OutputTensor> run(
      const std::vector<InputTensor>& inputs,
      const std::vector<std::string>& outputNames) override;

  // Run inference returning raw ORT values (zero-copy output).
  // Only available on OnnxSession (not IOnnxSession) since it exposes ORT
  // types.
  inline std::vector<Ort::Value> runRaw(const InputTensor &input);
  inline std::vector<Ort::Value> runRaw(const std::vector<InputTensor> &inputs);
  inline std::vector<Ort::Value>
  runRaw(const std::vector<InputTensor> &inputs,
         const std::vector<std::string> &outputNames);

  // Check if session is valid and ready
  [[nodiscard]] inline bool isValid() const override;

  // Get the model path
  [[nodiscard]] inline const std::string& modelPath() const override;

 private:
  std::string modelPath_;
  std::unique_ptr<Ort::Session> session_;
  Ort::AllocatorWithDefaultOptions allocator_;
  Ort::MemoryInfo memoryInfo_ =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  std::vector<std::string> inputNames_;
  std::vector<std::string> outputNames_;
  std::vector<const char *> outputNamePtrs_;
  Ort::RunOptions runOptions_;

  // Create an ORT tensor from a single InputTensor (avoids duplication)
  inline Ort::Value createInputOrtValue(const InputTensor &input);

  // Platform-aware session construction (Windows needs wide strings)
  static inline std::unique_ptr<Ort::Session> createOrtSession(
      Ort::Env& env, const std::string& path,
      const Ort::SessionOptions& options);
};

// ---------------------------------------------------------------------------
// Inline implementation
// ---------------------------------------------------------------------------

inline std::unique_ptr<Ort::Session> OnnxSession::createOrtSession(
    Ort::Env& env, const std::string& path,
    const Ort::SessionOptions& options) {
#if defined(_WIN32) || defined(_WIN64)
  std::wstring widePath(path.begin(), path.end());
  return std::make_unique<Ort::Session>(env, widePath.c_str(), options);
#else
  return std::make_unique<Ort::Session>(env, path.c_str(), options);
#endif
}

inline OnnxSession::OnnxSession(const std::string& modelPath,
                                const SessionConfig& config)
    : modelPath_(modelPath) {
  QLOG(logger::Priority::INFO,
       std::string("[OnnxSession] Loading model: ") + modelPath);
  ONNX_ALOG("[OnnxSession] Loading model: %s", modelPath.c_str());

  auto& env = OnnxRuntime::instance().env();
  Ort::SessionOptions sessionOptions = buildSessionOptions(config);

  // Create the session with fallback chain:
  //   1. Try with requested config (may include GPU EP + XNNPACK)
  //   2. If XNNPACK enabled and init fails, retry without XNNPACK
  //   3. If a non-CPU provider was requested and init fails, retry CPU-only
  try {
    session_ = createOrtSession(env, modelPath, sessionOptions);
  } catch (const std::exception &e) {
    bool retried = false;

    // Retry without XNNPACK (e.g. NHWC schema conflicts)
    if (config.enableXnnpack) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Session init failed: ") + e.what() +
               ", retrying without XNNPACK");
      ONNX_ALOG(
          "[OnnxSession] Session init failed: %s, retrying without XNNPACK",
          e.what());
      try {
        SessionConfig fallbackConfig = config;
        fallbackConfig.enableXnnpack = false;
        session_ = createOrtSession(env, modelPath,
                                    buildSessionOptions(fallbackConfig));
        retried = true;
        QLOG(logger::Priority::INFO,
             "[OnnxSession] Session created without XNNPACK");
        ONNX_ALOG("[OnnxSession] Session created without XNNPACK");
      } catch (const std::exception &) {
        // Fall through to CPU-only retry below
      }
    }

    // Retry with CPU-only (e.g. DirectML OOM on machines without a real GPU)
    if (!retried && config.provider != ExecutionProvider::CPU) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Session init failed: ") + e.what() +
               ", retrying with CPU-only");
      ONNX_ALOG("[OnnxSession] Session init failed: %s, retrying with CPU-only",
                e.what());
      try {
        SessionConfig cpuConfig = config;
        cpuConfig.provider = ExecutionProvider::CPU;
        cpuConfig.enableXnnpack = false;
        session_ =
            createOrtSession(env, modelPath, buildSessionOptions(cpuConfig));
        retried = true;
        QLOG(logger::Priority::INFO,
             "[OnnxSession] Session created with CPU fallback");
        ONNX_ALOG("[OnnxSession] Session created with CPU fallback");
      } catch (const std::exception &) {
        // All retries exhausted
      }
    }

    if (!retried) {
      throw;
    }
  }

  // Cache input/output names
  const size_t numInputs = session_->GetInputCount();
  inputNames_.reserve(numInputs);
  for (size_t i = 0; i < numInputs; ++i) {
    auto namePtr = session_->GetInputNameAllocated(i, allocator_);
    inputNames_.emplace_back(namePtr.get());
  }

  const size_t numOutputs = session_->GetOutputCount();
  outputNames_.reserve(numOutputs);
  outputNamePtrs_.reserve(numOutputs);
  for (size_t i = 0; i < numOutputs; ++i) {
    auto namePtr = session_->GetOutputNameAllocated(i, allocator_);
    outputNames_.emplace_back(namePtr.get());
  }
  for (const auto &name : outputNames_) {
    outputNamePtrs_.push_back(name.c_str());
  }

  QLOG(logger::Priority::INFO,
       std::string("[OnnxSession] Session ready, ") +
           std::to_string(numInputs) + " input(s), " +
           std::to_string(numOutputs) + " output(s)");
  ONNX_ALOG("[OnnxSession] Session ready, %zu input(s), %zu output(s)",
            numInputs, numOutputs);
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

inline const std::string &OnnxSession::inputName(size_t index) const {
  return inputNames_[index];
}

inline const std::string &OnnxSession::outputName(size_t index) const {
  return outputNames_[index];
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
  auto ortOutputs = runRaw(inputs, outputNames);

  // Convert ORT outputs to OutputTensor (deep copy)
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

inline Ort::Value OnnxSession::createInputOrtValue(const InputTensor &input) {
  switch (input.type) {
  case TensorType::FLOAT32:
    return Ort::Value::CreateTensor<float>(
        memoryInfo_,
        const_cast<float *>(static_cast<const float *>(input.data)),
        input.dataSize / sizeof(float), input.shape.data(), input.shape.size());
  case TensorType::INT64:
    return Ort::Value::CreateTensor<int64_t>(
        memoryInfo_,
        const_cast<int64_t *>(static_cast<const int64_t *>(input.data)),
        input.dataSize / sizeof(int64_t), input.shape.data(),
        input.shape.size());
  case TensorType::INT32:
    return Ort::Value::CreateTensor<int32_t>(
        memoryInfo_,
        const_cast<int32_t *>(static_cast<const int32_t *>(input.data)),
        input.dataSize / sizeof(int32_t), input.shape.data(),
        input.shape.size());
  case TensorType::UINT8:
    return Ort::Value::CreateTensor<uint8_t>(
        memoryInfo_,
        const_cast<uint8_t *>(static_cast<const uint8_t *>(input.data)),
        input.dataSize / sizeof(uint8_t), input.shape.data(),
        input.shape.size());
  case TensorType::INT8:
    return Ort::Value::CreateTensor<int8_t>(
        memoryInfo_,
        const_cast<int8_t *>(static_cast<const int8_t *>(input.data)),
        input.dataSize / sizeof(int8_t), input.shape.data(),
        input.shape.size());
  default:
    return Ort::Value::CreateTensor<float>(
        memoryInfo_,
        const_cast<float *>(static_cast<const float *>(input.data)),
        input.dataSize / sizeof(float), input.shape.data(), input.shape.size());
  }
}

inline std::vector<Ort::Value> OnnxSession::runRaw(const InputTensor &input) {
  if (!isValid()) {
    QLOG(logger::Priority::ERROR,
         std::string(
             "[OnnxSession] Run failed: session is not valid for model ") +
             modelPath_);
    throw std::runtime_error("OnnxSession is not valid");
  }
  QLOG_DEBUG(std::string("[OnnxSession] Running inference on ") + modelPath_ +
             " with 1 input(s)");

  const char *inputNamePtr = input.name.c_str();
  Ort::Value inputTensor = createInputOrtValue(input);

  return session_->Run(runOptions_, &inputNamePtr, &inputTensor, 1,
                       outputNamePtrs_.data(), outputNamePtrs_.size());
}

inline std::vector<Ort::Value>
OnnxSession::runRaw(const std::vector<InputTensor> &inputs) {
  return runRaw(inputs, outputNames_);
}

inline std::vector<Ort::Value>
OnnxSession::runRaw(const std::vector<InputTensor> &inputs,
                    const std::vector<std::string> &outputNames) {
  if (!isValid()) {
    QLOG(logger::Priority::ERROR,
         std::string(
             "[OnnxSession] Run failed: session is not valid for model ") +
             modelPath_);
    throw std::runtime_error("OnnxSession is not valid");
  }
  QLOG_DEBUG(std::string("[OnnxSession] Running inference on ") + modelPath_ +
             " with " + std::to_string(inputs.size()) + " input(s)");

  // Prepare input tensors
  std::vector<Ort::Value> inputTensors;
  inputTensors.reserve(inputs.size());

  std::vector<const char *> inputNamePtrs;
  inputNamePtrs.reserve(inputs.size());

  for (const auto &input : inputs) {
    inputNamePtrs.push_back(input.name.c_str());
    inputTensors.push_back(createInputOrtValue(input));
  }

  // Use cached output name pointers when requesting all outputs
  const char *const *outPtrs;
  size_t outCount;
  std::vector<const char *> customOutputNamePtrs;

  if (&outputNames == &outputNames_) {
    // Common path: requesting all outputs — use cached pointers
    outPtrs = outputNamePtrs_.data();
    outCount = outputNamePtrs_.size();
  } else {
    customOutputNamePtrs.reserve(outputNames.size());
    for (const auto &name : outputNames) {
      customOutputNamePtrs.push_back(name.c_str());
    }
    outPtrs = customOutputNamePtrs.data();
    outCount = customOutputNamePtrs.size();
  }

  // Run inference
  return session_->Run(runOptions_, inputNamePtrs.data(), inputTensors.data(),
                       inputTensors.size(), outPtrs, outCount);
}

inline bool OnnxSession::isValid() const {
  return session_ != nullptr;
}

inline const std::string& OnnxSession::modelPath() const {
  return modelPath_;
}

}  // namespace onnx_addon
