#pragma once
#include <string>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>

#include "AddonCpp.hpp"

namespace {{CPP_NAMESPACE}} {

inline js_value_t* sayHello(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  std::string name = js::String(env, args.get(0, "name")).as<std::string>(env);

  std::string greeting = HelloWorld::greet(name);

  js_value_t* result = nullptr;
  js_create_string_utf8(
      env,
      reinterpret_cast<const utf8_t*>(greeting.data()),
      greeting.size(),
      &result);
  return result;
}
JSCATCH

} // namespace {{CPP_NAMESPACE}}
