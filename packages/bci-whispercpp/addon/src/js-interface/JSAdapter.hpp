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

  void loadContextParams(
      qvac_lib_inference_addon_cpp::js::Object contextParamsObj, js_env_t* env,
      BCIConfig& config);

  void loadMiscParams(
      qvac_lib_inference_addon_cpp::js::Object miscParamsObj, js_env_t* env,
      BCIConfig& config);

  void loadBCIParams(
      qvac_lib_inference_addon_cpp::js::Object bciParamsObj, js_env_t* env,
      BCIConfig& config);

private:
  void loadMap(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env,
      std::map<std::string, JSValueVariant>& output);
};

} // namespace qvac_lib_inference_addon_bci
