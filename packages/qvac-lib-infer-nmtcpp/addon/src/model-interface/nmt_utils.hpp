#pragma once

#include <string>
#include <thread>

#include <ggml-backend.h>

int get_optimal_thread_count();

int64_t get_time_us();

bool ggml_graph_compute_helper(
    ggml_backend_sched_t sched, struct ggml_cgraph* graph, int n_threads,
    bool sched_reset = true);

// Case-insensitive substring check: returns true if the lowercased form of
// `name` contains `needle_lower` (which must already be lowercased).
// Used by nmt_backend_init_gpu and make_buft_list to keep device selection
// in lock-step.
bool nmt_name_contains_ci(const char* name, const std::string& needle_lower);

// Shared GPU device selection used by both nmt_backend_init_gpu (for backend
// init) and make_buft_list (for buffer-type assignment). Returning the same
// dev pointer from one helper guarantees compute and tensor-buffer placement
// agree — repeated drift between the two functions has been a maintenance
// hazard across multiple review rounds (see QVAC-17790 round-8 R8-D1).
//
// `log_prefix` is used only for diagnostic WARN/DEBUG messages so each caller
// can be identified in logcat (e.g. "[nmt_backend_init_gpu]" vs
// "[make_buft_list]"). Does NOT take the global init mutex; caller must
// ensure backend registration is complete before calling.
//
// Returns the selected non-CPU device whose buffer type is verified non-null,
// or nullptr if no eligible device was found (including when a device matched
// but its buffer type was null — a WARNING is emitted in that case). Callers
// do NOT need to re-check the buffer type of a non-null return value.
ggml_backend_dev_t nmt_select_gpu_device(
    bool use_gpu, const std::string& gpu_backend, int gpu_device,
    const char* log_prefix);
