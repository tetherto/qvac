#include "OnnxSession.hpp"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <stdexcept>
#include <utility>

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace onnx_addon {

namespace {

// Convert our TensorType to ONNX element type
ONNXTensorElementDataType toOnnxType(TensorType type) {
  switch (type) {
    case TensorType::FLOAT32:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
    case TensorType::FLOAT16:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16;
    case TensorType::INT64:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64;
    case TensorType::INT32:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32;
    case TensorType::INT8:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8;
    case TensorType::UINT8:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8;
    default:
      return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
  }
}

// Convert ONNX element type to our TensorType
TensorType fromOnnxType(ONNXTensorElementDataType onnxType) {
  switch (onnxType) {
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
      return TensorType::FLOAT32;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16:
      return TensorType::FLOAT16;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
      return TensorType::INT64;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32:
      return TensorType::INT32;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8:
      return TensorType::INT8;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8:
      return TensorType::UINT8;
    default:
      return TensorType::FLOAT32;
  }
}

// Build session options based on config
Ort::SessionOptions buildSessionOptions(const SessionConfig& config) {
  Ort::SessionOptions sessionOptions;

  // Set graph optimization level (using global ONNX Runtime enum values)
  switch (config.optimization) {
    case GraphOptimizationLevel::DISABLE:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_DISABLE_ALL);
      break;
    case GraphOptimizationLevel::BASIC:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_BASIC);
      break;
    case GraphOptimizationLevel::EXTENDED:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
      break;
    case GraphOptimizationLevel::ALL:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_ALL);
      break;
  }

  // CPU-only mode
  if (config.provider == ExecutionProvider::CPU) {
    sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
    sessionOptions.SetInterOpNumThreads(config.interOpThreads);
    return sessionOptions;
  }

  // Try to set up GPU provider
  const auto providers = Ort::GetAvailableProviders();

#ifdef __ANDROID__
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::NNAPI) {
    try {
      const bool nnapiAvailable =
          std::find(providers.begin(), providers.end(),
                    "NnapiExecutionProvider") != providers.end();

      if (nnapiAvailable) {
        uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(
            sessionOptions, nnapiFlags));
      }
    } catch (const std::exception& /*e*/) {
      // Fall back to CPU
    }
  }

#elif defined(__APPLE__)
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::CoreML) {
    try {
      const bool coremlAvailable =
          std::find(providers.begin(), providers.end(),
                    "CoreMLExecutionProvider") != providers.end();

      if (coremlAvailable) {
        sessionOptions.AppendExecutionProvider("CoreML");
      }
    } catch (const std::exception& /*e*/) {
      // Fall back to CPU
    }
  }

#elif defined(_WIN32) || defined(_WIN64)
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::DirectML) {
    try {
      const bool dmlAvailable =
          std::find(providers.begin(), providers.end(),
                    "DmlExecutionProvider") != providers.end();

      if (dmlAvailable) {
        sessionOptions.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
        sessionOptions.DisableMemPattern();
        Ort::ThrowOnError(
            OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
      }
    } catch (const std::exception& /*e*/) {
      // Fall back to CPU
    }
  }
#endif

  // Set threading options (applies to CPU fallback as well)
  sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
  sessionOptions.SetInterOpNumThreads(config.interOpThreads);

  return sessionOptions;
}

}  // namespace

// Implementation struct (PIMPL)
struct OnnxSession::Impl {
  std::string modelPath;
  Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "OnnxAddon"};
  std::unique_ptr<Ort::Session> session;
  Ort::AllocatorWithDefaultOptions allocator;

  // Cached input/output names
  std::vector<std::string> inputNames;
  std::vector<std::string> outputNames;

  // Get all output names
  std::vector<const char*> getOutputNamePtrs() const {
    std::vector<const char*> ptrs;
    ptrs.reserve(outputNames.size());
    for (const auto& name : outputNames) {
      ptrs.push_back(name.c_str());
    }
    return ptrs;
  }
};

OnnxSession::OnnxSession(const std::string& modelPath,
                         const SessionConfig& config)
    : impl_(std::make_unique<Impl>()) {
  impl_->modelPath = modelPath;

  // Build session options
  Ort::SessionOptions sessionOptions = buildSessionOptions(config);

  // Create session
#if defined(_WIN32) || defined(_WIN64)
  // Windows uses wide strings for paths
  std::wstring wideModelPath(modelPath.begin(), modelPath.end());
  impl_->session =
      std::make_unique<Ort::Session>(impl_->env, wideModelPath.c_str(), sessionOptions);
#else
  impl_->session =
      std::make_unique<Ort::Session>(impl_->env, modelPath.c_str(), sessionOptions);
#endif

  // Cache input names
  const size_t numInputs = impl_->session->GetInputCount();
  impl_->inputNames.reserve(numInputs);
  for (size_t i = 0; i < numInputs; ++i) {
    auto namePtr = impl_->session->GetInputNameAllocated(i, impl_->allocator);
    impl_->inputNames.emplace_back(namePtr.get());
  }

  // Cache output names
  const size_t numOutputs = impl_->session->GetOutputCount();
  impl_->outputNames.reserve(numOutputs);
  for (size_t i = 0; i < numOutputs; ++i) {
    auto namePtr = impl_->session->GetOutputNameAllocated(i, impl_->allocator);
    impl_->outputNames.emplace_back(namePtr.get());
  }
}

OnnxSession::~OnnxSession() = default;

OnnxSession::OnnxSession(OnnxSession&&) noexcept = default;
OnnxSession& OnnxSession::operator=(OnnxSession&&) noexcept = default;

std::vector<TensorInfo> OnnxSession::getInputInfo() const {
  std::vector<TensorInfo> infos;
  const size_t numInputs = impl_->session->GetInputCount();
  infos.reserve(numInputs);

  for (size_t i = 0; i < numInputs; ++i) {
    TensorInfo info;
    info.name = impl_->inputNames[i];

    auto typeInfo = impl_->session->GetInputTypeInfo(i);
    auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();

    info.shape = tensorInfo.GetShape();
    info.type = fromOnnxType(tensorInfo.GetElementType());

    infos.push_back(std::move(info));
  }

  return infos;
}

std::vector<TensorInfo> OnnxSession::getOutputInfo() const {
  std::vector<TensorInfo> infos;
  const size_t numOutputs = impl_->session->GetOutputCount();
  infos.reserve(numOutputs);

  for (size_t i = 0; i < numOutputs; ++i) {
    TensorInfo info;
    info.name = impl_->outputNames[i];

    auto typeInfo = impl_->session->GetOutputTypeInfo(i);
    auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();

    info.shape = tensorInfo.GetShape();
    info.type = fromOnnxType(tensorInfo.GetElementType());

    infos.push_back(std::move(info));
  }

  return infos;
}

std::vector<OutputTensor> OnnxSession::run(const InputTensor& input) {
  return run(std::vector<InputTensor>{input});
}

std::vector<OutputTensor> OnnxSession::run(
    const std::vector<InputTensor>& inputs) {
  return run(inputs, impl_->outputNames);
}

std::vector<OutputTensor> OnnxSession::run(
    const std::vector<InputTensor>& inputs,
    const std::vector<std::string>& outputNames) {
  if (!isValid()) {
    throw std::runtime_error("OnnxSession is not valid");
  }

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
  auto ortOutputs = impl_->session->Run(
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

bool OnnxSession::isValid() const {
  return impl_ && impl_->session;
}

const std::string& OnnxSession::modelPath() const {
  return impl_->modelPath;
}

}  // namespace onnx_addon
