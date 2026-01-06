#include <js.h>
#include <bare.h>
#include "test_logger.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"

auto testLoggerExports(js_env_t *env, js_value_t *exports) -> js_value_t* {

// NOLINTNEXTLINE(cppcoreguidelines-macro-usage)
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

  V("setLogger", test_logger::setLogger)
  V("cppLog", test_logger::cppLog)
  V("dummyCppLogWork", test_logger::dummyCppLogWork)
  V("dummyMultiThreadedCppLogWork", test_logger::dummyMultiThreadedCppLogWork)
  V("releaseLogger", test_logger::releaseLogger)
#undef V

  return exports;
}

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
BARE_MODULE(test_logger, testLoggerExports)

