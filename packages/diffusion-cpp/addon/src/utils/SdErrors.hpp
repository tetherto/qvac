#pragma once

#include <inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd::errors {

// Stable identifiers used in StatusError so JS callers can switch on a
// well-known (addonId, code) pair instead of pattern-matching error strings.
//
// The `Cancelled` code is intentionally distinct from
// `general_error::InternalError`: a user-initiated cancel is not a fault and
// should not be conflated with an unexpected internal failure on the JS side.
inline constexpr const char* ADDON_ID = "Diffusion";
inline constexpr const char* CANCELLED = "Cancelled";
inline constexpr const char* JOB_CANCELLED_MESSAGE = "Job cancelled";

// Convenience factory so the four cancel sites stay perfectly in sync.
inline qvac_errors::StatusError makeCancelledError() {
  return qvac_errors::StatusError(ADDON_ID, CANCELLED, JOB_CANCELLED_MESSAGE);
}

} // namespace qvac_lib_inference_addon_sd::errors
