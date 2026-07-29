cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(
  inference_addon_cpp_mobile_tests
  VERSION 0.1.0
  LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_bare_module(inference_addon_cpp_mobile_tests EXPORTS)

target_sources(
  ${inference_addon_cpp_mobile_tests}
  PRIVATE
  binding.cpp
  test_logger.cpp
  output_callback_lifetime.cpp
)

# Pull in the header-only inference-addon-cpp library (src/inference-addon-cpp/*).
target_include_directories(
  ${inference_addon_cpp_mobile_tests}
  PRIVATE
  ../src
)

# Route QLOG/JsLogger to the JS bridge, matching the desktop logger sub-package
# (tests/integration_js/logger builds with ENABLE_JS_LOGGER=ON → JS_LOGGER).
#
# Deliberately TARGET-WIDE, not per-source. Scoping it to test_logger.cpp alone
# (set_source_files_properties) looks tidier and would mirror desktop more
# closely, but it is NOT SAFE here: JS_LOGGER switches the QLOG macro definition
# in Logger.hpp, and QLOG is called from INLINE bodies in shared headers that
# several translation units include — MultiJobScheduler.hpp (x5),
# OutputCallbackJs.hpp (x4), OutputQueue.hpp, AddonJs.hpp, InitLoader.hpp,
# GGUFShards.hpp. Defining it for only one TU would compile those same inline
# functions with different bodies in different TUs: an ODR violation, where the
# linker keeps one arbitrarily and behaviour becomes build/platform dependent.
#
# Consequence (accepted): unlike desktop — where each sub-package is its own
# target and only logger enables JS_LOGGER — here output-callback-lifetime's
# internal QLOG also routes through JsLogger. With no logger installed those
# calls take JsLogger's no-owner path (the same one the desktop logger suite
# asserts drops orphaned entries), and the generated test-groups.json runs each
# suite in its own app process, so logger state cannot leak into it.
target_compile_definitions(${inference_addon_cpp_mobile_tests} PUBLIC JS_LOGGER)

if(WIN32)
  target_compile_definitions(
    ${inference_addon_cpp_mobile_tests}
    PRIVATE
    NOMINMAX
    WIN32_MEAN_AND_LEAN
    NOGDI
  )

  target_compile_options(${inference_addon_cpp_mobile_tests} PRIVATE "/utf-8")
endif()
