#pragma once

// Backward-compatibility header. SingleJobScheduler now lives beside its
// IJobScheduler siblings in job/SingleJobScheduler.hpp; this header keeps the
// historical include path and the JobRunner alias working unchanged.
#include "job/SingleJobScheduler.hpp"

namespace qvac_lib_inference_addon_cpp {

/// Backward-compatibility alias — all existing code naming JobRunner still
/// compiles without modification.
using JobRunner = SingleJobScheduler;

} // namespace qvac_lib_inference_addon_cpp
