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

// Shared deterministic GPU selection policy used independently by
// nmt_backend_init_gpu (backend init) and make_buft_list (buffer assignment),
// keeping compute and tensor-buffer placement aligned for an unchanged
// registry. Drift between these callers has been a recurring maintenance
// hazard (see QVAC-17790 round-8 R8-D1).
// gpuDevice is an ordinal within devices matching the eligible family set;
// unsupported registered families do not occupy the execution list.
//
// `logPrefix` is used only for diagnostic WARN/DEBUG messages so each caller
// can be identified in logcat (e.g. "[nmt_backend_init_gpu]" vs
// "[make_buft_list]"). Does NOT take the global init mutex; caller must
// ensure backend registration is complete before calling.
//
// Returns the selected non-CPU device whose buffer type is verified non-null,
// or nullptr if no eligible device was found (including when a device matched
// but its buffer type was null — a WARNING is emitted in that case). Callers
// do NOT need to re-check the buffer type of a non-null return value.
ggml_backend_dev_t nmtSelectGpuDevice(
    bool useGpu, const std::string& gpuBackend, int gpuDevice,
    const char* logPrefix);

ggml_backend_dev_t nmtSelectGpuDevice(
    const NmtBackendInterface& backend, bool useGpu,
    const std::string& gpuBackend, int gpuDevice, const char* logPrefix,
    bool allowDefaultOpenCl = false);
