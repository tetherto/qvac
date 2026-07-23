#pragma once

#include <onnxruntime_cxx_api.h>

#include "OnnxTensor.hpp"

namespace onnx_addon {

// Convert our TensorType to ONNX element type
inline ONNXTensorElementDataType toOnnxType(TensorType type) {
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
inline TensorType fromOnnxType(ONNXTensorElementDataType onnxType) {
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

}  // namespace onnx_addon
