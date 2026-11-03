#pragma once
#include <algorithm>
#include <string>
#include <vector>

namespace qvac::ttsggml::addon_js {

/// Holds a fit result to the app's own memory limit, as iOS enforces it. Every
/// unified row draws on that one limit: each row's free memory is capped at
/// @p budget, and a load whose unified rows together take more than @p budget
/// less @p margin does not fit. A budget of 0 is an exhausted limit. Returns
/// the status to report.
template <typename Row>
std::string applyAppMemoryBudget(
    const std::string& status, std::vector<Row>& rows, double budget,
    double margin) {
  double unifiedUsed = 0;
  for (Row& row : rows) {
    if (!row.unified) {
      continue;
    }
    row.freeBytes = std::min(row.freeBytes, budget);
    unifiedUsed += row.usedBytes;
  }
  return status == "fits" && unifiedUsed + margin > budget ? "does-not-fit"
                                                           : status;
}

} // namespace qvac::ttsggml::addon_js
