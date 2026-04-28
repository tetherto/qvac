// NOLINTBEGIN
#include <thread>

#include <ggml-backend.h>
#include <ggml.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "nmt.hpp"

// Get optimal number of threads for computation
// Optimized for GitHub runners (typically 2 CPUs) and other environments
int get_optimal_thread_count() {
  unsigned int hw_threads = std::thread::hardware_concurrency();
  if (hw_threads == 0) {
    // Fallback if hardware_concurrency() fails
    return 2;
  }
  // For GitHub runners (typically 2 CPUs), use both cores
  // For machines with more cores, use most but leave 1-2 for system
  if (hw_threads <= 2) {
    return hw_threads; // Use all available cores
  } else if (hw_threads <= 16) {
    return hw_threads - 1; // Leave 1 core
  } else {
    return hw_threads - 2; // Leave 2 cores for system on high-core machines
  }
}

int64_t get_time_us() {
#ifdef _WIN32
  static LARGE_INTEGER frequency = []() {
    LARGE_INTEGER freq;
    QueryPerformanceFrequency(&freq);
    return freq;
  }();
  LARGE_INTEGER counter;
  if (QueryPerformanceCounter(&counter)) {
    return (counter.QuadPart * 1000000) / frequency.QuadPart;
  }
  return GetTickCount64() * 1000;
#else
  return ggml_time_us();
#endif
}

bool ggml_graph_compute_helper(
    ggml_backend_sched_t sched, struct ggml_cgraph* graph, int n_threads,
    bool sched_reset = true) {
  for (int i = 0; i < ggml_backend_sched_get_n_backends(sched); ++i) {
    ggml_backend_t backend = ggml_backend_sched_get_backend(sched, i);
    ggml_backend_dev_t dev = ggml_backend_get_device(backend);
    ggml_backend_reg_t reg = dev ? ggml_backend_dev_backend_reg(dev) : nullptr;

    auto* fn_set_n_threads =
        (ggml_backend_set_n_threads_t)ggml_backend_reg_get_proc_address(
            reg, "ggml_backend_set_n_threads");
    if (fn_set_n_threads) {
      fn_set_n_threads(backend, n_threads);
    }
  }

  const bool t =
      (ggml_backend_sched_graph_compute(sched, graph) == GGML_STATUS_SUCCESS);

  if (!t || sched_reset) {
    ggml_backend_sched_reset(sched);
  }

  return t;
}
// NOLINTEND
