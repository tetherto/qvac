#pragma once

#include <exception>
#include <utility>

#include <common/log.h>

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
  ~ScopeGuard() {
    if (active_) {
      try {
        fn_();
      } catch (const std::exception& ex) {
        LOG_WRN("ScopeGuard(%s): cleanup threw: %s\n", label_, ex.what());
      } catch (...) {
        LOG_WRN("ScopeGuard(%s): cleanup threw a non-exception\n", label_);
      }
    }
  }
  ScopeGuard(ScopeGuard&& other) noexcept
      : fn_(std::move(other.fn_)),
        label_(other.label_),
        active_(other.active_) {
    other.dismiss();
  }
  ScopeGuard(const ScopeGuard&) = delete;
  ScopeGuard& operator=(const ScopeGuard&) = delete;
  ScopeGuard& operator=(ScopeGuard&&) = delete;
  void dismiss() { active_ = false; }
};
