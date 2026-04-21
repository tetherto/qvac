#include <bare.h>

#include "../addon/AddonJs.hpp"

js_value_t*
qvacLibInferVlaExports(js_env_t* env, js_value_t* exports) {

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("createVlaModel", qvac_lib_infer_vla::createVlaModel)
  V("destroyVlaModel", qvac_lib_infer_vla::destroyVlaModel)
  V("runVlaModel", qvac_lib_infer_vla::runVlaModel)
  V("getVlaHparams", qvac_lib_infer_vla::getVlaHparams)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE("qvac-lib-infer-vla", qvacLibInferVlaExports)
