#pragma once

#include <functional>
#include <map>
#include <string>

#include <js.h>

#include "addon/BCIErrors.hpp"
#include "model-interface/bci/BCIConfig.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_inference_addon_cpp::js {
class Object;
}

namespace qvac_lib_inference_addon_bci {

class JSAdapter {
public:
  JSAdapter() = default;

  auto loadFromJSObject(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env)
      -> BCIConfig;

  auto loadContextParams(
      qvac_lib_inference_addon_cpp::js::Object contextParamsObj, js_env_t* env,
      BCIConfig& config)
      -> BCIConfig;

  auto loadMiscParams(
      qvac_lib_inference_addon_cpp::js::Object miscParamsObj, js_env_t* env,
      BCIConfig& config)
      -> BCIConfig;

  auto loadBCIParams(
      qvac_lib_inference_addon_cpp::js::Object bciParamsObj, js_env_t* env,
      BCIConfig& config)
      -> BCIConfig;

private:
  void loadMap(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env,
      std::map<std::string, JSValueVariant>& output);
};

} // namespace qvac_lib_inference_addon_bci
