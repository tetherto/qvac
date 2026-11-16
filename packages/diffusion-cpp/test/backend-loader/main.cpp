#include "utils/BackendLoader.hpp"
#include <cstdio>
#include <ggml-backend.h>
#include <ggml.h>
#include <stdexcept>
#include <string>
#include <thread>

using qvac_lib_inference_addon_sd::loadBackendModulesOnce;

bool missingCpuFails(const char *directory) {
  try {
    loadBackendModulesOnce(directory);
  } catch (const std::runtime_error &error) {
    return std::string(error.what()).find("CPU backend module is missing") !=
           std::string::npos;
  }
  return false;
}

bool computeCpu() {
  auto *backend =
      ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  if (!backend)
    return false;
  const ggml_init_params params = {1024 * 1024, nullptr, true};
  auto *ctx = ggml_init(params);
  if (!ctx) {
    ggml_backend_free(backend);
    return false;
  }
  auto *input = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
  auto *output = ggml_scale(ctx, input, 2.0f);
  auto *graph = ggml_new_graph(ctx);
  ggml_build_forward_expand(graph, output);
  auto *buffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
  if (!buffer) {
    ggml_free(ctx);
    ggml_backend_free(backend);
    return false;
  }
  const float value = 3.0f;
  ggml_backend_tensor_set(input, &value, 0, sizeof(value));
  const bool computed =
      ggml_backend_graph_compute(backend, graph) == GGML_STATUS_SUCCESS;
  float result = 0;
  ggml_backend_tensor_get(output, &result, 0, sizeof(result));
  ggml_backend_buffer_free(buffer);
  ggml_free(ctx);
  ggml_backend_free(backend);
  return computed && result == 6.0f;
}

int main(int argc, char **argv) {
  if (argc != 3 || ggml_backend_dev_count() != 0 || !missingCpuFails(argv[2]))
    return 1;
  try {
    loadBackendModulesOnce(argv[1]);
    std::thread first([&] { loadBackendModulesOnce(argv[1]); });
    std::thread second([&] { loadBackendModulesOnce(argv[1]); });
    first.join();
    second.join();
    if (ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU) != nullptr)
      return 1;
    if (ggml_backend_load("missing-gpu-module") != nullptr)
      return 1;
    return computeCpu() ? 0 : 1;
  } catch (const std::exception &error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
