#include <llama.h>

#include "fit/FitParams.hpp"

namespace model_fit {

void applyFitRequest(
    const FitRequest& request, llama_model_params& modelParams,
    llama_context_params& contextParams) {
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

} // namespace model_fit
