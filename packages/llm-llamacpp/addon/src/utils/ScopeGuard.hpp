#pragma once

#include <utility>

template <typename F> class ScopeGuard {
  F fn_;
  bool active_ = true;

public:
  explicit ScopeGuard(F&& fn) : fn_(std::move(fn)) {}
  // A destructor is implicitly noexcept, so an exception escaping the guarded
  // callable would call std::terminate rather than propagate. Guards here run
  // cleanup that can legitimately throw (rebuilding a sampler from restored
  // params, releasing a slot), so swallowing is the only safe option at this
  // point. Callers that must observe a cleanup failure should log inside the
  // callable rather than rely on the guard to surface it.
  ~ScopeGuard() {
    if (active_) {
      try {
        fn_();
      } catch (...) { // NOLINT(bugprone-empty-catch)
      }
    }
  }
  ScopeGuard(ScopeGuard&& other) noexcept
      : fn_(std::move(other.fn_)), active_(other.active_) {
    other.dismiss();
  }
  ScopeGuard(const ScopeGuard&) = delete;
  ScopeGuard& operator=(const ScopeGuard&) = delete;
  ScopeGuard& operator=(ScopeGuard&&) = delete;
  void dismiss() { active_ = false; }
};
