#pragma once

#include <thread>

int get_optimal_thread_count();

int64_t get_time_us();

bool ggml_graph_compute_helper(
    ggml_backend_sched_t sched, struct ggml_cgraph* graph, int n_threads,
    bool sched_reset = true);
