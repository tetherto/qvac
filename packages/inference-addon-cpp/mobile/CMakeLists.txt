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
)

# Pull in the header-only inference-addon-cpp library (src/inference-addon-cpp/*).
target_include_directories(
  ${inference_addon_cpp_mobile_tests}
  PRIVATE
  ../src
)

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
