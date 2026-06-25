#pragma once

// CPU graph-compute helper for the π₀.₅ parity tests.
//
// The legacy ggml_graph_compute_with_ctx() resolves the CPU backend's compute
// entry point at link time. Under GGML_BACKEND_DL=ON the CPU backend is a
// separately dlopen'd module, so that symbol is unresolved when the test binary
// is linked (ld.lld: undefined symbol: ggml_graph_compute_with_ctx). Run the
// graph through the backend registry instead — the same path the addon itself
// uses (see smolvla.cpp / pi05.cpp) — which only needs core ggml-base symbols
// and therefore links in both DL and static builds.

#include <ggml-backend.h>
#include <ggml.h>

namespace pi05_test {

// Computes a fully-built forward graph on the CPU backend. Returns the compute
// status so call sites keep asserting ASSERT_EQ(..., GGML_STATUS_SUCCESS).
inline ggml_status computeGraphCpu(ggml_cgraph* gf) {
  // Backends are loaded once before any test runs by the global test
  // environment (backend_env.cpp), so a CPU device is available here.
  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (cpuDev == nullptr) {
    return GGML_STATUS_FAILED;
  }
  ggml_backend_t backend = ggml_backend_dev_init(cpuDev, nullptr);
  const ggml_status status = ggml_backend_graph_compute(backend, gf);
  ggml_backend_free(backend);
  return status;
}

} // namespace pi05_test
