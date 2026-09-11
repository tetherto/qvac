#include <iostream>
#include <stdexcept>
#include <string>

#include <llama.h>

#include "fit/FitParams.hpp"

namespace {

int g_failures = 0;

void expect(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    ++g_failures;
  }
}

model_fit::FitRequest splitRequest(int32_t splitMode) {
  model_fit::FitRequest request;
  request.splitMode = splitMode;
  request.hasSplitMode = true;
  return request;
}

model_fit::FitResult
successPlan(int32_t nGpuLayers, int32_t splitMode, int32_t mainGpu) {
  model_fit::FitResult result;
  result.status = 0;
  result.fits = true;
  result.nGpuLayers = nGpuLayers;
  result.splitMode = splitMode;
  result.mainGpu = mainGpu;
  return result;
}

} // namespace

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

  {
    expect(
        model_fit::requiresSupportedGpu(splitRequest(0), false),
        "NONE must require a supported GPU");
    expect(
        !model_fit::requiresSupportedGpu(splitRequest(0), true),
        "NONE with its target rejected to CPU must not require a GPU");
    expect(
        model_fit::requiresSupportedGpu(splitRequest(3), false),
        "TENSOR must require a supported GPU");
    expect(
        model_fit::requiresSupportedGpu(splitRequest(3), true),
        "TENSOR has no CPU form even with a rejected target");
    expect(
        !model_fit::requiresSupportedGpu(splitRequest(1), false),
        "LAYER must not require a GPU");
    expect(
        !model_fit::requiresSupportedGpu(model_fit::FitRequest{}, false),
        "an unpinned split mode must not require a GPU");

    bool rejectedRow = false;
    try {
      model_fit::applyFitRequest(splitRequest(2), modelParams, contextParams);
    } catch (const std::invalid_argument& error) {
      rejectedRow =
          std::string(error.what()) ==
          "model-fit: splitMode 2 (ROW) is not accepted; use 1 (LAYER) or 3 "
          "(TENSOR)";
    }
    expect(rejectedRow, "ROW must be rejected with the LAYER/TENSOR redirect");
    expect(
        modelParams.split_mode != LLAMA_SPLIT_MODE_ROW,
        "a rejected ROW must not be written to the model params");

    model_fit::FitRequest sentinel = splitRequest(0);
    sentinel.nGpuLayers = 0;
    sentinel.hasNGpuLayers = true;
    sentinel.mainGpu = -1;
    sentinel.hasMainGpu = true;
    expect(
        model_fit::isExplicitCpuPlacement(sentinel),
        "0 layers, NONE and mainGpu -1 is the CPU sentinel");
    expect(
        !model_fit::requiresSupportedGpu(sentinel, false),
        "the CPU sentinel must not require a GPU");

    model_fit::FitRequest zeroLayersOnGpu = sentinel;
    zeroLayersOnGpu.mainGpu = 0;
    expect(
        !model_fit::isExplicitCpuPlacement(zeroLayersOnGpu),
        "0 layers with a GPU target is not the CPU sentinel");
    expect(
        model_fit::requiresSupportedGpu(zeroLayersOnGpu, false),
        "0 layers on a GPU target still needs the GPU");
  }

  {
    const ggml_backend_dev_t cpuList[] = {nullptr};
    const ggml_backend_dev_t gpuList[] = {
        reinterpret_cast<ggml_backend_dev_t>(1), nullptr};

    model_fit::FitResult gpuPlan = successPlan(24, 1, 7);
    expect(
        !model_fit::isCpuOnlyPlan(gpuPlan, gpuList),
        "layers on a listed GPU is a GPU plan");
    model_fit::normalizePlanPlacement(gpuPlan, gpuList, false, false);
    expect(
        gpuPlan.mainGpu == 0 && gpuPlan.splitMode == 1 &&
            gpuPlan.nGpuLayers == 24,
        "a GPU plan must report mainGpu 0 and keep its split mode and layers");

    model_fit::FitResult cpuByList = successPlan(-1, 1, 0);
    expect(
        model_fit::isCpuOnlyPlan(cpuByList, cpuList),
        "the bare terminator is a CPU-only plan");
    model_fit::normalizePlanPlacement(cpuByList, cpuList, false, false);
    expect(
        cpuByList.mainGpu == -1 && cpuByList.splitMode == 0 &&
            cpuByList.nGpuLayers == 0,
        "an unpinned CPU-only plan must report the CPU sentinels");

    model_fit::FitResult cpuByLayers = successPlan(0, 1, 0);
    expect(
        model_fit::isCpuOnlyPlan(cpuByLayers, gpuList),
        "zero layers on a listed GPU is a CPU-only plan");
    model_fit::normalizePlanPlacement(cpuByLayers, gpuList, false, false);
    expect(
        cpuByLayers.mainGpu == -1 && cpuByLayers.splitMode == 0,
        "a plan that offloads nothing must report the CPU sentinels");

    model_fit::FitResult pinned = successPlan(5, 1, 0);
    model_fit::normalizePlanPlacement(pinned, cpuList, true, true);
    expect(
        pinned.mainGpu == -1 && pinned.splitMode == 1 && pinned.nGpuLayers == 5,
        "pinned split mode and layers must survive a CPU-only plan");

    model_fit::FitResult failure = successPlan(-1, 1, 3);
    failure.status = 1;
    failure.fits = false;
    expect(
        !model_fit::isCpuOnlyPlan(failure, cpuList),
        "a FAILURE carries no plan to classify");
    model_fit::normalizePlanPlacement(failure, cpuList, false, false);
    expect(
        failure.mainGpu == 3 && failure.splitMode == 1 &&
            failure.nGpuLayers == -1,
        "a FAILURE must be left as the fitter returned it");

    // `mainGpu` must be non-zero: 0 is what a normalized GPU plan carries, so
    // it cannot tell "left alone" from "normalized".
    model_fit::FitResult error = successPlan(0, 0, 3);
    error.status = 2;
    error.fits = false;
    model_fit::normalizePlanPlacement(error, nullptr, false, false);
    expect(
        error.mainGpu == 3, "an ERROR must be left as the fitter returned it");

    expect(
        model_fit::FitResult{}.mainGpu == -1,
        "a result that never reached the fitter reports the CPU sentinel");
  }

  return g_failures == 0 ? 0 : 1;
}
