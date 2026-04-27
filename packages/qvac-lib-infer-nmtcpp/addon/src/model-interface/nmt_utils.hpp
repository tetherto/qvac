#pragma once

#include <string>
#include <thread>

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
