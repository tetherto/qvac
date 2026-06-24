#pragma once

#include <exception>

namespace qvac_lib_inference_addon_cpp::utils {

template <typename F> struct OnExit {
  OnExit(F&& f) : f_{std::forward<F>(f)} {}
  ~OnExit() { f_(); }

  F f_;
};

template <typename F> [[nodiscard]] auto onExit(F&& f) -> OnExit<F> {
  return OnExit{std::forward<F>(f)};
}

template <typename F> struct OnError {
  OnError(F&& f) : ue_{std::uncaught_exceptions()}, f_{std::forward<F>(f)} {}
  ~OnError() {
    if (std::uncaught_exceptions() > ue_)
      f_();
  }

  int ue_;
  F f_;
};

template <typename F> [[nodiscard]] auto onError(F&& f) -> OnError<F> {
  return OnError{std::forward<F>(f)};
}

template <typename T, std::size_t N>
constexpr std::size_t arrayCount(const T (&)[N]) {
  return N;
}

} // namespace qvac_lib_inference_addon_cpp::utils
