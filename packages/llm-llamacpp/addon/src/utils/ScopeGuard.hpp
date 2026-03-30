#pragma once

#include <utility>

template <typename F> class ScopeGuard {
  F fn_;
  bool active_ = true;

public:
  explicit ScopeGuard(F&& fn) : fn_(std::move(fn)) {}
  ~ScopeGuard() {
    if (active_) {
      fn_();
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
