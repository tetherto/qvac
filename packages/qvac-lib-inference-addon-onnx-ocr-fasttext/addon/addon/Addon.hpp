#pragma once

#include "qvac-lib-inference-addon-cpp/Addon.hpp"
#include "pipeline/Pipeline.hpp"

namespace qvac_lib_inference_addon_cpp {
    template<>
    void Addon<qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline>::jsOutputCallback(uv_async_t* handle);

    template<>
    uint32_t Addon<qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline>::append(int priority, qvac_lib_inference_addon_onnx_ocr_fasttext::PipelineInput input); 

    template<>
    void Addon<qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline>::process();
}

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

using Addon = qvac_lib_inference_addon_cpp::Addon<Pipeline>;

}
