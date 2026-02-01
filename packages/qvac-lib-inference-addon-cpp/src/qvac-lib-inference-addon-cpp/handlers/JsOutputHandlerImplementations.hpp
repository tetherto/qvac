#pragma once

#include <functional>
#include <span>
#include <string>
#include <type_traits>

#include <js.h>

#include "../JsUtils.hpp"
#include "../RuntimeStats.hpp"
#include "../queue/OutputQueue.hpp"
#include "OutputHandler.hpp"

namespace qvac_lib_inference_addon_cpp::out_handl {
struct JsOutputHandlerInterface : virtual OutputHandlerInterface<js_value_t*> {
  virtual void setEnv(js_env_t* env) = 0;
};

/// @brief Similar to BaseOutputHandler, but for JavaScript environments
template <typename ModelOutT>
struct JsBaseOutputHandler : public BaseOutputHandler<js_value_t*, ModelOutT>,
                             public JsOutputHandlerInterface {
  JsBaseOutputHandler(function<js_value_t*(const ModelOutT&)> callbackF)
      : BaseOutputHandler<js_value_t*, ModelOutT>(callbackF) {}

  void setEnv(js_env_t* env) final { env_ = env; }

protected:
  js_env_t* env_ = nullptr;
};

struct JsStringOutputHandler : JsBaseOutputHandler<string> {
  JsStringOutputHandler()
      : JsBaseOutputHandler<string>([this](const string& out) -> js_value_t* {
          return js::String::create(this->env_, out);
        }) {}
};

template <typename T>
struct JsTypedArrayOutputHandler : JsBaseOutputHandler<vector<T>> {
  JsTypedArrayOutputHandler()
      : JsBaseOutputHandler<vector<T>>(
            [this](const vector<T>& data) -> js_value_t* {
              span<const T> span = {data.data(), data.size()};
              return js::TypedArray<T>::create(this->env_, span);
            }) {}
};

template <typename ContainerT, typename T>
class Js2DArrayOutputHandler : public JsBaseOutputHandler<ContainerT> {
  template <typename C, typename = void> struct has_size : false_type {};

  template <typename C>
  struct has_size<C, void_t<decltype(declval<const C&>().size())>> : true_type {
  };

  template <typename C>
  using subscript_return_type = decltype(declval<const C&>()[0]);

  static_assert(
      has_size<ContainerT>::value, "ContainerT must have a size() method");

  static_assert(
      is_same_v<subscript_return_type<ContainerT>, span<const T>>,
      "ContainerT must have operator[] that returns std::span<const T>");

public:
  Js2DArrayOutputHandler()
      : JsBaseOutputHandler<ContainerT>(
            [this](const ContainerT& data) -> js_value_t* {
              auto array = js::Array::create(this->env_);
              for (size_t i = 0; i < data.size(); i++) {
                span<const T> row = data[i];
                auto inner = js::TypedArray<T>::create(this->env_, row);
                array.set(this->env_, i, inner);
              }
              return array;
            }) {}
};

/// @brief Handler for RuntimeStats that converts to JavaScript object
struct JsRuntimeStatsOutputHandler : JsBaseOutputHandler<RuntimeStats> {
  JsRuntimeStatsOutputHandler()
      : JsBaseOutputHandler<RuntimeStats>(
            [this](const RuntimeStats& stats) -> js_value_t* {
              js::Object runtimeStats = js::Object::create(this->env_);
              for (const auto& p : stats) {
                visit(
                    [env = this->env_, &runtimeStats, &p](auto&& val) {
                      runtimeStats.setProperty(
                          env, p.first.c_str(), js::Number::create(env, val));
                    },
                    p.second);
              }
              return runtimeStats;
            }) {}
};

/// @brief Handler for Output::LogMsg that puts message in output data position
struct JsLogMsgOutputHandler : JsBaseOutputHandler<Output::LogMsg> {
  JsLogMsgOutputHandler()
      : JsBaseOutputHandler<Output::LogMsg>(
            [this](const Output::LogMsg& logMsg) -> js_value_t* {
              return js::String::create(this->env_, logMsg);
            }) {}
};

/// @brief Handler for Output::Error that converts error to JavaScript string
struct JsErrorOutputHandler : JsBaseOutputHandler<Output::Error> {
  JsErrorOutputHandler()
      : JsBaseOutputHandler<Output::Error>(
            [this](const Output::Error& error) -> js_value_t* {
              return js::String::create(this->env_, error);
            }) {}
};
} // namespace qvac_lib_inference_addon_cpp::out_handl
