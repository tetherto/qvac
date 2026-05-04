#pragma once

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

// Shared GPU device selection used by both nmt_backend_init_gpu (for backend
// init) and make_buft_list (for buffer-type assignment). Returning the same
// dev pointer from one helper guarantees compute and tensor-buffer placement
// agree — repeated drift between the two functions has been a maintenance
// hazard across multiple review rounds (see QVAC-17790 round-8 R8-D1).
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
