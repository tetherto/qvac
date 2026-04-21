#include <bare.h>

#include "../addon/AddonJs.hpp"

js_value_t*
{{EXPORT_FN_NAME}}(js_env_t* env, js_value_t* exports) {

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

  V("sayHello", {{CPP_NAMESPACE}}::sayHello)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE("{{PACKAGE_NAME}}", {{EXPORT_FN_NAME}})
