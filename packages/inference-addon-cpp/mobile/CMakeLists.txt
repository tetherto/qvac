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

# All C++ is GENERATED from the desktop bindings (tests/integration_js/*) and
# gitignored, so it does not exist in a fresh checkout.
#
# INVARIANT: every context that runs bare-make must run `npm run test:mobile:generate`
# first — in CI that means EVERY building job, since jobs don't share workspaces.
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/generated/native/sources.cmake")
  message(FATAL_ERROR
    "Generated native sources are missing.\n"
    "Run `npm run test:mobile:generate` in packages/inference-addon-cpp/mobile "
    "before configuring this target.")
endif()

include("${CMAKE_CURRENT_SOURCE_DIR}/generated/native/sources.cmake")

target_sources(
  ${inference_addon_cpp_mobile_tests}
  PRIVATE
  ${QVAC_MOBILE_GENERATED_SOURCES}
)

# Pull in the header-only inference-addon-cpp library (src/inference-addon-cpp/*).
target_include_directories(
  ${inference_addon_cpp_mobile_tests}
  PRIVATE
  ../src
)

# Routes QLOG to the JS logger, as the desktop logger sub-package does.
#
# MUST stay TARGET-WIDE — do not scope per source file. JS_LOGGER switches the QLOG
# macro, and QLOG is called from inline bodies in shared headers (MultiJobScheduler.hpp,
# OutputCallbackJs.hpp, AddonJs.hpp, OutputQueue.hpp, ...), so per-source scoping would
# compile the same inline functions differently per TU: an ODR violation.
#
# Accepted consequence: output-callback-lifetime's QLOG also routes through JsLogger
# (desktop leaves it on stdout). With no logger installed those calls take the no-owner
# path, and test-groups.json isolates each suite in its own process.
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
