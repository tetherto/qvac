#pragma once

#include <algorithm>
#include <any>
#include <functional>
#include <memory>
#include <vector>

#include "../Errors.hpp"
#include "../Logger.hpp"

namespace {
using namespace std;
using namespace qvac_lib_inference_addon_cpp::logger;

template <typename T> void throwInvalidInputType(const any& input) {
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InternalError,
      "Invalid input type " + string(input.type().name()) +
          " for handler type " + typeid(T).name());
}

/// @brief Call a method (member function) with type checked arguments
template <typename T, typename F, typename Obj>
auto callTypeChecked(F&& function, const std::any& arg, Obj* obj) {
  auto* castedArg = any_cast<T>(&arg);
  if (!castedArg) {
    throwInvalidInputType<T>(arg);
  }
  return invoke(forward<F>(function), obj, *castedArg);
}

template <typename T> bool canHandle(const any& input) {
  bool result = input.type() == typeid(T);
  QLOG(
      Priority::DEBUG,
      "canHandle<" + string(typeid(T).name()) + "> for input type " +
          string(input.type().name()) + " = " + (result ? "TRUE" : "FALSE"));
  return result;
}
} // namespace

namespace qvac_lib_inference_addon_cpp::out_handl {
using namespace std;

template <typename T> struct OutputHandlerInterface {
  virtual ~OutputHandlerInterface() = default;
  OutputHandlerInterface() = default;
  OutputHandlerInterface(const OutputHandlerInterface&) = delete;
  OutputHandlerInterface& operator=(const OutputHandlerInterface&) = delete;

  [[nodiscard]] virtual T handleOutput(const any& output) const = 0;
  [[nodiscard]] virtual bool canHandle(const any& input) const = 0;
};

/// @brief Base class that calls the configured callback function to handle the
/// OutT and returns the HandledT
template <typename HandledT, typename OutT>
class BaseOutputHandler : public virtual OutputHandlerInterface<HandledT> {
  HandledT handleOutputTyped(const OutT& out) const { return callbackF_(out); }
  function<HandledT(const OutT&)> callbackF_;

public:
  explicit BaseOutputHandler(function<HandledT(const OutT&)> callbackF)
      : callbackF_(callbackF) {}

  ~BaseOutputHandler() = default;

  HandledT handleOutput(const any& output) const final {
    return ::callTypeChecked<OutT>(
        &BaseOutputHandler<HandledT, OutT>::handleOutputTyped, output, this);
  }

  [[nodiscard]] bool canHandle(const any& input) const override {
    return ::canHandle<OutT>(input);
  }
};

/// @brief Container for output handlers
/// @note Expects provided handlers to be non-null
/// @tparam HandlerT a Handler interface or abstract base class
template <typename HandlerT> class OutputHandlers {
  vector<shared_ptr<HandlerT>> hlers_;

public:
  OutputHandlers() = default;

  HandlerT& get(const any& input) {
    auto it = find_if(hlers_.begin(), hlers_.end(), [&](const auto& h) {
      return h->canHandle(input);
    });
    if (it == hlers_.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "No OutputHandler found for input type " +
              string(input.type().name()));
    }
    return *(it->get());
  }

  void add(shared_ptr<HandlerT> handler) { hlers_.push_back(move(handler)); }
};
} // namespace qvac_lib_inference_addon_cpp::out_handl
