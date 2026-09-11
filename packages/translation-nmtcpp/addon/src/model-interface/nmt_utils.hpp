#pragma once

#include <cstddef>
#include <string>
#include <thread>

#include <ggml-backend.h>

// NOLINTBEGIN(readability-identifier-naming)
int get_optimal_thread_count();

int64_t get_time_us();

bool ggml_graph_compute_helper(
    ggml_backend_sched_t sched, struct ggml_cgraph* graph, int n_threads,
    bool sched_reset = true);
// NOLINTEND(readability-identifier-naming)

// Replace non-printable and non-ASCII bytes with '?' so driver-provided
// strings are safe for logging and JS consumption.
std::string sanitizePrintableAscii(const std::string& input);

// Case-insensitive substring check: returns true if the lowercased form of
// `name` contains `needleLower` (which must already be lowercased).
// Used by nmt_backend_init_gpu and make_buft_list to keep device selection
// in lock-step.
bool nmtNameContainsCi(const char* name, const std::string& needleLower);

struct NmtBackendInterface {
  size_t (*deviceCount)();
  ggml_backend_dev_t (*deviceGet)(size_t index);
  enum ggml_backend_dev_type (*deviceType)(ggml_backend_dev_t device);
  const char* (*deviceName)(ggml_backend_dev_t device);
  ggml_backend_reg_t (*deviceRegistry)(ggml_backend_dev_t device);
  const char* (*registryName)(ggml_backend_reg_t registry);
  ggml_backend_buffer_type_t (*deviceBufferType)(ggml_backend_dev_t device);
};

// Shared GPU device selection used by both nmt_backend_init_gpu (for backend
// init) and make_buft_list (for buffer-type assignment). Returning the same
// dev pointer from one helper guarantees compute and tensor-buffer placement
// agree — repeated drift between the two functions has been a maintenance
// hazard (see QVAC-17790 round-8 R8-D1). gpuDevice is an ordinal within the
// eligible family inventory.
//
// `logPrefix` is used only for diagnostic WARN/DEBUG messages so each caller
// can be identified in logcat (e.g. "[nmt_backend_init_gpu]" vs
// "[make_buft_list]"). Does NOT take the global init mutex; caller must
// ensure backend registration is complete before calling.
//
// Returns the selected eligible GPU/iGPU device with a non-null buffer type,
// or nullptr if no eligible device was found (including when a device matched
// but its buffer type was null — a WARNING is emitted in that case). Callers
// do NOT need to re-check the buffer type of a non-null return value.
//
// Both production call sites go through this 4-arg overload, so the
// model-buffer device and the compute device cannot disagree by construction.
// That parity is not directly testable: both callers have internal linkage and
// bind the real ggml symbols, so reaching them would mean giving them external
// linkage and an injection seam of their own, which is deliberately not done.
// Note that a selector-stability assertion would not cover it either — it holds
// even if a call site diverges.
ggml_backend_dev_t nmtSelectGpuDevice(
    bool useGpu, const std::string& gpuBackend, int gpuDevice,
    const char* logPrefix);

ggml_backend_dev_t nmtSelectGpuDevice(
    const NmtBackendInterface& backend, bool useGpu,
    const std::string& gpuBackend, int gpuDevice, const char* logPrefix,
    bool allowDefaultOpenCl = false);
