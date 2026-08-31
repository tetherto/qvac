#pragma once

#include <exception>
#include <string>
#include <utility>

#include "common/common.h"
#include "utils/LoggingMacros.hpp"

template <typename F> class ScopeGuard {
  F fn_;
  const char* label_;
  bool active_ = true;

public:
  /// @param label optional name for this guard, echoed if cleanup throws.
  explicit ScopeGuard(F&& fn, const char* label = "unnamed")
      : fn_(std::move(fn)), label_(label) {}
  // A destructor is implicitly noexcept, so an exception escaping the guarded
  // callable would call std::terminate rather than propagate. Guards here run
  // cleanup that can legitimately throw (rebuilding a sampler from restored
  // params, releasing a slot), so swallowing is the only safe option at this
  // point. It is logged rather than silent: a cleanup failure can leave shared
  // state inconsistent, and without a line here that happens invisibly.
  // Callers that need to react to a failure must still catch inside the
  // callable — the guard cannot propagate.
  //
  // Logging is itself wrapped, because it allocates and takes a mutex: an
  // exception leaving a catch handler in a noexcept destructor is the same
  // std::terminate this catch exists to prevent.
  ~ScopeGuard() {
    if (active_) {
      try {
        fn_();
      } catch (const std::exception& ex) {
        logCleanupFailure(ex.what());
      } catch (...) {
        logCleanupFailure("non-exception");
      }
    }
  }
  ScopeGuard(ScopeGuard&& other) noexcept
      : fn_(std::move(other.fn_)), label_(other.label_),
        active_(other.active_) {
    other.dismiss();
  }
  ScopeGuard(const ScopeGuard&) = delete;
  ScopeGuard& operator=(const ScopeGuard&) = delete;
  ScopeGuard& operator=(ScopeGuard&&) = delete;
  void dismiss() { active_ = false; }

private:
  // `QLOG_IF` to match the package's other logging header
  // (model-interface/ReasoningRecoveryHelpers.hpp), so a guard failure honours
  // the configured verbosity and lands in the same sink as its callers.
  void logCleanupFailure(const char* reason) const noexcept {
    try {
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          string_format("ScopeGuard(%s): cleanup threw: %s\n", label_, reason));
    } catch (...) { // NOLINT(bugprone-empty-catch)
      // Nothing left to do: the logger is the thing that failed.
    }
  }
};
