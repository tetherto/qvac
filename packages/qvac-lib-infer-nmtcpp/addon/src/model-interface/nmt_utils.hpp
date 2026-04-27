#pragma once

#include <algorithm>
#include <cctype>
#include <cstring>
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
inline bool nmt_name_contains_ci(const char* name, const std::string& needle_lower) {
  if (name == nullptr || needle_lower.empty()) {
    return false;
  }
  for (const char* p = name; *p != '\0'; ++p) {
    const char* s = p;
    const char* n = needle_lower.c_str();
    while (*s != '\0' && *n != '\0' &&
           static_cast<char>(std::tolower(static_cast<unsigned char>(*s))) == *n) {
      ++s;
      ++n;
    }
    if (*n == '\0') {
      return true;
    }
  }
  return false;
}

