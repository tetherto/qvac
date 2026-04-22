#include "OnnxInferSession.hpp"
#include "OrtSessionFactory.hpp"

#include <iostream>
#include <qvac-onnx/OnnxConfig.hpp>
#include <qvac-onnx/OnnxSessionOptionsBuilder.hpp>

namespace qvac::ttslib::chatterbox {

namespace {

ONNXTensorElementDataType ourTypeToOnnxType(OrtElementType elementType) {
  switch (elementType) {
  case OrtElementType::Fp16:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16;
  case OrtElementType::Fp32:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
  case OrtElementType::Fp64:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_DOUBLE;
  case OrtElementType::Int4:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT4;
  case OrtElementType::Int8:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8;
  case OrtElementType::Int16:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT16;
  case OrtElementType::Int32:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32;
  case OrtElementType::Int64:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64;
  case OrtElementType::UInt4:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT4;
  case OrtElementType::UInt8:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8;
  case OrtElementType::UInt16:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16;
  case OrtElementType::UInt32:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT32;
  case OrtElementType::UInt64:
    return ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT64;
  default:
    throw std::runtime_error("Invalid our tensor element data type");
  }
}

OrtElementType onnxTypeToOurType(ONNXTensorElementDataType onnxType) {
  switch (onnxType) {
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16:
    return OrtElementType::Fp16;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
    return OrtElementType::Fp32;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_DOUBLE:
    return OrtElementType::Fp64;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT4:
    return OrtElementType::Int4;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8:
    return OrtElementType::Int8;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT16:
    return OrtElementType::Int16;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32:
    return OrtElementType::Int32;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
    return OrtElementType::Int64;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT4:
    return OrtElementType::UInt4;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8:
    return OrtElementType::UInt8;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16:
    return OrtElementType::UInt16;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT32:
    return OrtElementType::UInt32;
  case ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT64:
    return OrtElementType::UInt64;
  default:
    throw std::runtime_error("Invalid ONNX tensor element data type");
  }
}

} // namespace

OnnxInferSession::OnnxInferSession(const std::string &modelPath, bool useGPU,
                                   int numThreads) {
  onnx_addon::SessionConfig sessionCfg;
  sessionCfg.provider = useGPU ? onnx_addon::ExecutionProvider::AUTO_GPU
                               : onnx_addon::ExecutionProvider::CPU;
  sessionCfg.optimization = onnx_addon::GraphOptimizationLevel::EXTENDED;
  sessionCfg.intraOpThreads = numThreads > 0 ? numThreads : 1;

  Ort::SessionOptions options = onnx_addon::buildSessionOptions(sessionCfg);

  try {
    session_ = qvac::ttslib::createOrtSession(modelPath, options);
  } catch (const std::exception &e) {
    if (sessionCfg.provider != onnx_addon::ExecutionProvider::CPU) {
      onnx_addon::SessionConfig cpuCfg = sessionCfg;
      cpuCfg.provider = onnx_addon::ExecutionProvider::CPU;
      Ort::SessionOptions cpuOptions =
          onnx_addon::buildSessionOptions(cpuCfg);
      session_ = qvac::ttslib::createOrtSession(modelPath, cpuOptions);
    } else {
      throw;
    }
  }

  // collect input names
  for (size_t i = 0; i < session_->GetInputCount(); i++) {
    const Ort::AllocatedStringPtr inputName =
        session_->GetInputNameAllocated(i, allocator_);
    inputNames_.push_back(std::string(inputName.get()));
  }

  // collect output names
  for (size_t i = 0; i < session_->GetOutputCount(); i++) {
    Ort::AllocatedStringPtr outputName =
        session_->GetOutputNameAllocated(i, allocator_);
    outputNames_.push_back(std::string(outputName.get()));
  }
}

OrtTensor OnnxInferSession::getInput(const std::string &inputName) {
  for (const auto &input : inputTensors_) {
    if (input.name == inputName) {
      return input;
    }
  }
  throw std::runtime_error("Input not found");
}

OrtTensor OnnxInferSession::getOutput(const std::string &outputName) {
  for (const auto &output : outputTensors_) {
    if (output.name == outputName) {
      return output;
    }
  }
  throw std::runtime_error("Output not found");
}

void OnnxInferSession::run() {
  std::vector<const char *> inputNames;
  for (const auto &name : inputNames_) {
    inputNames.push_back(name.c_str());
  }

  std::vector<const char *> outputNames;
  for (const auto &name : outputNames_) {
    outputNames.push_back(name.c_str());
  }

  outputsTensorsValues_ = session_->Run(
      Ort::RunOptions{nullptr}, inputNames.data(), inputTensorsValues_.data(),
      inputTensorsValues_.size(), outputNames.data(), outputNames.size());

  outputTensors_.clear();

  for (size_t i = 0; i < outputsTensorsValues_.size(); i++) {
    outputTensors_.emplace_back(OrtTensor{
        outputsTensorsValues_[i].GetTensorMutableData<void>(), outputNames_[i],
        outputsTensorsValues_[i].GetTensorTypeAndShapeInfo().GetShape(),
        onnxTypeToOurType(outputsTensorsValues_[i]
                              .GetTensorTypeAndShapeInfo()
                              .GetElementType())});
  }
}

std::vector<std::string> OnnxInferSession::getInputNames() const {
  return inputNames_;
}

std::vector<std::string> OnnxInferSession::getOutputNames() const {
  return outputNames_;
}

void OnnxInferSession::initInputTensors(
    const std::vector<std::vector<int64_t>> &inputShapes) {
  inputTensors_.clear();
  inputTensorsValues_.clear();

  for (size_t i = 0; i < session_->GetInputCount(); i++) {
    const Ort::TypeInfo inputTypeInfo = session_->GetInputTypeInfo(i);
    const Ort::ConstTensorTypeAndShapeInfo inputShapeInfo =
        inputTypeInfo.GetTensorTypeAndShapeInfo();

    std::vector<int64_t> inputShape = inputShapes[i];
    ONNXTensorElementDataType onnxType = inputShapeInfo.GetElementType();

    Ort::Value inputValue = Ort::Value::CreateTensor(
        allocator_, inputShape.data(), inputShape.size(), onnxType);
    inputTensorsValues_.push_back(std::move(inputValue));

    inputTensors_.emplace_back(
        OrtTensor{inputTensorsValues_[i].GetTensorMutableData<void>(),
                  inputNames_[i], inputShape, onnxTypeToOurType(onnxType)});
  }
}

} // namespace qvac::ttslib::chatterbox