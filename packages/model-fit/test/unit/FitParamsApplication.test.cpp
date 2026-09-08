#include <iostream>

#include <llama.h>

#include "fit/FitParams.hpp"

int main() {
  llama_model_params modelParams = {};
  llama_context_params contextParams = {};

  model_fit::FitRequest omitted;
  omitted.swaFull = false;
  omitted.hasSwaFull = false;
  contextParams.swa_full = true;
  model_fit::applyFitRequest(omitted, modelParams, contextParams);
  if (!contextParams.swa_full) {
    std::cerr << "omitted swaFull must preserve the context default\n";
    return 1;
  }

  model_fit::FitRequest enabled;
  enabled.swaFull = true;
  enabled.hasSwaFull = true;
  contextParams.swa_full = false;
  model_fit::applyFitRequest(enabled, modelParams, contextParams);
  if (!contextParams.swa_full) {
    std::cerr << "explicit true must enable full SWA\n";
    return 1;
  }

  model_fit::FitRequest disabled;
  disabled.swaFull = false;
  disabled.hasSwaFull = true;
  contextParams.swa_full = true;
  model_fit::applyFitRequest(disabled, modelParams, contextParams);
  if (contextParams.swa_full) {
    std::cerr << "explicit false must disable full SWA\n";
    return 1;
  }

  model_fit::FitRequest cpuPlacement;
  cpuPlacement.mainGpu = -1;
  cpuPlacement.hasMainGpu = true;
  modelParams.main_gpu = 0;
  model_fit::applyFitRequest(cpuPlacement, modelParams, contextParams);
  if (modelParams.main_gpu != -1) {
    std::cerr << "the CPU mainGpu sentinel must be applied exactly\n";
    return 1;
  }

  return 0;
}
