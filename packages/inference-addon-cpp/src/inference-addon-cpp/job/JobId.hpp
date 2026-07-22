#pragma once

#include <cstdint>

namespace qvac_lib_inference_addon_cpp {

/// Identifier a scheduler stamps on every output (result, job-ended, error) so
/// a multi-job consumer can correlate interleaved events to their request.
using JobId = uint64_t;

/// Sentinel for outputs not tied to a specific job (single-job schedulers).
inline constexpr JobId kNoJobId = 0;

} // namespace qvac_lib_inference_addon_cpp
