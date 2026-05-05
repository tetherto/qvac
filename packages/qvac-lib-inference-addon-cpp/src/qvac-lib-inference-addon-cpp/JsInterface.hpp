#pragma once

#include <algorithm>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <vector>

#include "Errors.hpp"
#include "JsLogger.hpp"
#include "JsUtils.hpp"
#include "ModelInterfaces.hpp"
#include "addon/AddonJs.hpp"

namespace qvac_lib_inference_addon_cpp {

class JsArgsParser {
  std::vector<js_value_t*> args_;

  std::unordered_map<std::string, std::string>
  toUnorderedMap(js_env_t* env, js::Object jsMap, const char* subMapKey) {
    bool result = false;
    auto key = js::String::create(env_, subMapKey);
    JS(js_has_property(env_, jsMap, key, &result));
    assert(result);

    auto config = jsMap.getProperty<js::Object>(env, subMapKey);
    js_value_t* configKeys = nullptr;
    JS(js_get_property_names(env, config, &configKeys));
    uint32_t configKeysSz = 0;
    JS(js_get_array_length(env, configKeys, &configKeysSz));
    std::unordered_map<std::string, std::string> cppMap;
    while (configKeysSz-- > 0) {
      js_value_t* key = nullptr;
      JS(js_get_element(env, configKeys, configKeysSz, &key));
      auto* content = config.getProperty(env, key);
      cppMap[js::String::fromValue(key).as<std::string>(env)] =
          js::String{env, content}.as<std::string>(env);
    }
    return cppMap;
  }

  void validateIndex(int argIndex, const char* type, const char* keyName) {
    if (argIndex < 0 || argIndex >= args_.size()) {
      std::string message = std::string("Expected ") + type + " '" + keyName +
                            "' at index " + std::to_string(argIndex) +
                            " but got only " + std::to_string(args_.size()) +
                            " arguments";
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument, message);
    }
  }

public:
  js_env_t* const env_;

  JsArgsParser(js_env_t* env, js_callback_info_t* info)
      : args_(js::getArguments(env, info)), env_(env) {}

  std::string getMapEntry(int argIndex, const char* keyName) {
    validateIndex(argIndex, "string map entry", keyName);
    auto jsMap = js::Object{env_, args_[argIndex]};
    return jsMap.getProperty<js::String>(env_, keyName).as<std::string>(env_);
  }

  std::unordered_map<std::string, std::string>
  getSubmap(int argIndex, const char* keyName) {
    validateIndex(argIndex, "submap", keyName);
    auto jsMap = js::Object{env_, args_[argIndex]};
    return JsArgsParser::toUnorderedMap(env_, jsMap, keyName);
  }

  js_value_t* get(int argIndex, const char* name) {
    validateIndex(argIndex, "value entry", name);
    return args_[argIndex];
  }

  js::Object getJsObject(int argIndex, const char* name) {
    validateIndex(argIndex, "js::Object", name);
    return js::Object{env_, args_[argIndex]};
  }

  void* getRawPointer(int argIndex, const char* name) {
    validateIndex(argIndex, "raw pointer", name);
    return js::External(env_, args_[argIndex]).as<void*>(env_);
  }

  js_value_t* getFunction(int argIndex, const char* name) {
    validateIndex(argIndex, "function", name);
    if (!js::is<js::Function>(env_, args_[argIndex])) {
      std::string message = std::string("Expected ") + name + " as function";
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument, message);
    }
    return args_[argIndex];
  }

  /// @brief Obtain mandatory object argument
  template <typename T>
  T getObject(
      int argIndex, const char* name,
      std::function<T(js_env_t* env, js::Object&)> serializer) {
    validateIndex(argIndex, "serializable object", name);
    js::Object jsObj{env_, args_[argIndex]};
    T serialized = serializer(env_, jsObj);
    return serialized;
  }

  /// @brief Try to obtain optional object argument
  template <typename T>
  std::optional<T> tryGetObject(
      int argIndex, const char* name,
      std::function<T(js_env_t* env, js::Object&)> serializer) {
    if (argIndex >= args_.size()) {
      return std::nullopt;
    }
    return getObject(argIndex, name, serializer);
  }

  /// @brief Try to obtain optional number argument
  /// @param argIndex The index of the argument to get
  /// @return std::optional<CppNumberType> containing the number if the argument
  /// exists and is a number, nullopt otherwise
  template <typename CppNumberType>
  std::optional<CppNumberType> getIntegralOptional(int argIndex) {
    static_assert(
        std::is_integral_v<CppNumberType>,
        "CppNumberType must be an integral type");
    if (argIndex < 0 || argIndex >= args_.size()) {
      return std::nullopt;
    }
    if (js::is<js::Null>(env_, args_[argIndex]) ||
        js::is<js::Undefined>(env_, args_[argIndex])) {
      return std::nullopt;
    }
    return js::Number(env_, args_[argIndex]).as<CppNumberType>(env_);
  }
};

using namespace qvac_errors;
class JsInterface {

public:
  static auto setLogger(js_env_t* env, js_callback_info_t* info)
      -> js_value_t* try {
    return logger::JsLogger::setLogger(env, info);
  }
  JSCATCH

  static auto releaseLogger(js_env_t* env, js_callback_info_t* info)
      -> js_value_t* try {
    logger::JsLogger::releaseLogger(env, info);
    return nullptr;
  }
  JSCATCH

private:
  /// @brief Per-env state holding the AddonJs instances bound to that env.
  ///
  /// Instances are stored per js_env_t* so that they can be deterministically
  /// destructed when the env tears down (via js_add_teardown_callback). Using a
  /// process-global vector with no env hook causes static-destruction-time
  /// teardown of the addons to race with downstream globals such as ggml /
  /// Vulkan ICDs, producing a SIGSEGV on shutdown.
  struct EnvState {
    std::vector<std::unique_ptr<AddonJs>> instances;
  };

  inline static std::mutex envsMtx_;
  inline static std::unordered_map<js_env_t*, std::unique_ptr<EnvState>> envs_;

  /// @brief Bare libjs teardown callback, invoked while the env (and its libuv
  /// loop) are still alive. Synchronously destructs all AddonJs instances bound
  /// to this env so model/backend teardown happens before C++ static
  /// destructors run.
  static void onEnvTeardown(void* arg) {
    auto* env = static_cast<js_env_t*>(arg);
    std::unique_ptr<EnvState> envState;
    {
      std::scoped_lock lock{envsMtx_};
      auto it = envs_.find(env);
      if (it == envs_.end()) {
        return;
      }
      envState = std::move(it->second);
      envs_.erase(it);
    }
    // Destruct outside the lock so individual AddonJs destructors (which may
    // join worker threads, etc.) cannot deadlock if they reentered the map.
  }

  /// @brief Look up the EnvState for an env. Caller must hold envsMtx_.
  /// Returns nullptr if no state exists for this env.
  static auto findEnvStateLocked(js_env_t* env) -> EnvState* {
    auto it = envs_.find(env);
    if (it == envs_.end()) {
      return nullptr;
    }
    return it->second.get();
  }

public:
  static auto getInstance(js_env_t* env, js_value_t* val) -> AddonJs& {
    auto handle = js::External(env, val).as<void*>(env);
    std::scoped_lock lockGuard{envsMtx_};
    auto* envState = findEnvStateLocked(env);
    if (envState == nullptr) {
      throw StatusError(general_error::InvalidArgument, "Invalid handle");
    }
    auto found = std::find_if(
        envState->instances.begin(),
        envState->instances.end(),
        [handle](auto& instanceUniquePtr) {
          return static_cast<void*>(instanceUniquePtr.get()) == handle;
        });
    if (found == envState->instances.end()) {
      throw StatusError(general_error::InvalidArgument, "Invalid handle");
    }
    return *static_cast<AddonJs*>(handle);
  }

  static auto createInstance(js_env_t* env, std::unique_ptr<AddonJs>&& addonJs)
      -> js_value_t* try {
    AddonJs* rawHandle = nullptr;
    bool registerHook = false;
    {
      std::scoped_lock lock{envsMtx_};
      auto it = envs_.find(env);
      if (it == envs_.end()) {
        it = envs_.emplace(env, std::make_unique<EnvState>()).first;
        registerHook = true;
      }
      auto& slot = it->second->instances.emplace_back(std::move(addonJs));
      rawHandle = slot.get();
    }
    if (registerHook) {
      // Register on first use of this env. Failure here means we leak the
      // EnvState until process exit, which is no worse than the legacy
      // behaviour, so we only log instead of unwinding.
      if (js_add_teardown_callback(env, &onEnvTeardown, env) != 0) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "Could not register js teardown callback for env; "
            "AddonJs instances will be destructed at static destruction time");
      }
    }
    return js::External::create(env, rawHandle);
  }
  JSCATCH

  static auto loadWeights(js_env_t* env, js_callback_info_t* info)
      -> js_value_t* try {
    JsArgsParser argsParser(env, info);
    auto& instance = getInstance(env, argsParser.get(0, "instance"));
    instance.loadWeights(env, argsParser.get(1, "weightsData"));
    return nullptr;
  }
  JSCATCH

  static auto activate(js_env_t* env, js_callback_info_t* info)
      -> js_value_t* try {
    JsArgsParser argsParser(env, info);
    auto& instance = getInstance(env, argsParser.get(0, "instance"));
    instance.addonCpp->activate();
    return nullptr;
  }
  JSCATCH

  /// @brief Can be used to get the input and type
  /// @example
  /// auto& instance = getInstance(env, argsParser.get(0, "instance"));
  /// auto [type, jsInput] = getInput(argsParser);
  ////
  /// std::any anyInput;
  /// if(type == "text") {
  ///   anyInput = js::String(env, jsInput).as<std::string>(env);
  /// }
  /// // ... other types
  ///
  /// if(!anyInput.has_value()) {
  ///   throw StatusError(general_error::InvalidArgument, "Invalid type");
  /// }
  /// instance.runJob(std::move(anyInput));
  static auto getInput(JsArgsParser& argsParser)
      -> std::pair<std::string, js_value_t*> {
    auto inputObj = argsParser.getJsObject(1, "inputObj");
    auto type = argsParser.getMapEntry(1, "type");
    auto input = inputObj.getProperty(argsParser.env_, "input");
    return std::make_pair(type, input);
  }

  /// @brief Can be used to get an array of inputs and their types
  /// @example
  /// auto inputs = getInputsArray(argsParser);
  ///
  /// for (auto& [type, inputObj] : inputs) {
  ///   std::any anyInput;
  ///   if(type == "text") {
  ///     anyInput = inputObj.getProperty<js::String>(env,
  ///     "input").as<std::string>(env);
  ///   }
  ///   // ... other types
  /// }
  static auto getInputsArray(JsArgsParser& argsParser)
      -> std::vector<std::pair<std::string, js::Object>> {
    auto* env = argsParser.env_;
    auto inputsArray = js::Array{env, argsParser.get(1, "inputsArray")};

    std::vector<std::pair<std::string, js::Object>> results;
    auto arraySz = inputsArray.size(env);
    results.reserve(arraySz);

    for (uint32_t i = 0; i < arraySz; ++i) {
      auto inputObj = inputsArray.get<js::Object>(env, i);
      auto type =
          inputObj.getProperty<js::String>(env, "type").as<std::string>(env);
      results.emplace_back(std::move(type), inputObj);
    }

    return results;
  }

  static auto destroyInstance(js_env_t* env, js_callback_info_t* info)
      -> js_value_t* try {
    JsArgsParser argsParser(env, info);
    auto handle = argsParser.getRawPointer(0, "instance");
    std::unique_ptr<AddonJs> doomed;
    {
      std::scoped_lock lockGuard{envsMtx_};
      auto* envState = findEnvStateLocked(env);
      if (envState == nullptr) {
        throw StatusError(general_error::InvalidArgument, "Invalid handle");
      }
      auto found = std::find_if(
          envState->instances.begin(),
          envState->instances.end(),
          [handle](auto& instanceUniquePtr) {
            return static_cast<void*>(instanceUniquePtr.get()) == handle;
          });
      if (found == envState->instances.end()) {
        throw StatusError(general_error::InvalidArgument, "Invalid handle");
      }
      // Move the unique_ptr out so the AddonJs destructor runs after the lock
      // is released (its dtor may join worker threads which could touch the
      // env state).
      doomed = std::move(*found);
      envState->instances.erase(found);
    }
    return nullptr;
  }
  JSCATCH

  static auto cancel(js_env_t* env, js_callback_info_t* info)
      -> js_value_t* try {
    JsArgsParser argsParser(env, info);
    auto& instance = getInstance(env, argsParser.get(0, "instance"));
    return instance.cancelJob();
  }
  JSCATCH
};
} // namespace qvac_lib_inference_addon_cpp
