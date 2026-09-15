#include <stdexcept>

#include <common/fit.h>
#include <llama.h>

#include "fit/FitParams.hpp"

namespace model_fit {

void applyFitRequest(
    const FitRequest& request, llama_model_params& modelParams,
    llama_context_params& contextParams) {
  // ROW is deprecated by fabric and no supported backend provides the split
  // buffers it needs.
  if (request.hasSplitMode && request.splitMode == LLAMA_SPLIT_MODE_ROW) {
    throw std::invalid_argument(
        "model-fit: splitMode 2 (ROW) is not accepted; use 1 (LAYER) or 3 "
        "(TENSOR)");
  }
  if (request.hasNGpuLayers) {
    modelParams.n_gpu_layers = request.nGpuLayers;
  }
  contextParams.n_ctx = request.nCtx;
  if (request.nBatch != 0) {
    contextParams.n_batch = request.nBatch;
  }
  if (request.nUbatch != 0) {
    contextParams.n_ubatch = request.nUbatch;
  }
  if (request.hasSplitMode) {
    modelParams.split_mode = static_cast<llama_split_mode>(request.splitMode);
  }
  if (request.hasMainGpu) {
    modelParams.main_gpu = request.mainGpu;
  }
  if (request.hasTypeK) {
    contextParams.type_k = static_cast<ggml_type>(request.typeK);
  }
  if (request.hasTypeV) {
    contextParams.type_v = static_cast<ggml_type>(request.typeV);
  }
  if (request.hasFlashAttnType) {
    contextParams.flash_attn_type =
        static_cast<llama_flash_attn_type>(request.flashAttnType);
  }
  if (request.hasSwaFull) {
    contextParams.swa_full = request.swaFull;
  }
}

bool isExplicitCpuPlacement(const FitRequest& request) {
  return request.hasNGpuLayers && request.nGpuLayers == 0 &&
         request.hasMainGpu && request.mainGpu == -1;
}

bool requiresSupportedGpu(
    const FitRequest& request, bool mainGpuRejectedToCpu) {
  if (!request.hasSplitMode) {
    return false;
  }
  if (request.splitMode == LLAMA_SPLIT_MODE_TENSOR) {
    return true;
  }
  return request.splitMode == LLAMA_SPLIT_MODE_NONE &&
         !isExplicitCpuPlacement(request) && !mainGpuRejectedToCpu;
}

bool isCpuOnlyPlan(const FitResult& result, const ggml_backend_dev_t* devices) {
  if (result.status != static_cast<int>(COMMON_PARAMS_FIT_STATUS_SUCCESS)) {
    return false;
  }
  return (devices != nullptr && devices[0] == nullptr) ||
         result.nGpuLayers == 0;
}

void normalizePlanPlacement(
    FitResult& result, const ggml_backend_dev_t* devices, bool splitModePinned,
    bool nGpuLayersPinned) {
  if (result.status != static_cast<int>(COMMON_PARAMS_FIT_STATUS_SUCCESS)) {
    return;
  }
  if (!isCpuOnlyPlan(result, devices)) {
    result.mainGpu = 0;
    return;
  }
  result.mainGpu = -1;
  if (!splitModePinned) {
    result.splitMode = static_cast<int32_t>(LLAMA_SPLIT_MODE_NONE);
  }
  if (!nGpuLayersPinned) {
    result.nGpuLayers = 0;
  }
}

} // namespace model_fit
