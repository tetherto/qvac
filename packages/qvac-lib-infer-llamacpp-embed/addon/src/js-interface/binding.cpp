#include <bare.h>
#include "qvac-lib-infer-llamacpp-embed.hpp"

js_value_t *qvac_lib_infer_llamacpp_embed_exports(js_env_t *env, js_value_t *exports) {  // NOLINT(readability-identifier-naming)

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn) \
  { \
    js_value_t *val; \
    if ( js_create_function(env, name, -1, fn, nullptr, &val) != 0) { \
      return nullptr; \
    } \
    if ( js_set_named_property(env, exports, name, val) != 0) { \
      return nullptr; \
    } \
  }

  V("createInstance", qvac_lib_infer_llamacpp_embed::createInstance)
  V("loadWeights", qvac_lib_infer_llamacpp_embed::loadWeights)
  V("activate", qvac_lib_infer_llamacpp_embed::activate)
  V("append", qvac_lib_infer_llamacpp_embed::append)
  V("status", qvac_lib_infer_llamacpp_embed::status)
  V("pause", qvac_lib_infer_llamacpp_embed::pause)
  V("stop", qvac_lib_infer_llamacpp_embed::stop)
  V("cancel", qvac_lib_infer_llamacpp_embed::cancel)
  V("destroyInstance", qvac_lib_infer_llamacpp_embed::destroyInstance)
  V("setLogger", qvac_lib_infer_llamacpp_embed::setLogger)
  V("releaseLogger", qvac_lib_infer_llamacpp_embed::releaseLogger)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(qvac-lib-infer-llamacpp-embed, qvac_lib_infer_llamacpp_embed_exports)
