cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(
  test_js_create_double_first_call
  VERSION 0.1.0
  LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_bare_module(test_js_create_double_first_call EXPORTS)

target_sources(
  ${test_js_create_double_first_call}
  PRIVATE
  binding.cpp
)

target_include_directories(
  ${test_js_create_double_first_call}
  PRIVATE
  ../../../src
)

if(WIN32)
  target_compile_definitions(
    ${test_js_create_double_first_call}
    PRIVATE
    NOMINMAX
    WIN32_MEAN_AND_LEAN
    NOGDI
  )

  target_compile_options(${test_js_create_double_first_call} PRIVATE "/utf-8")

  target_link_libraries(
    ${test_js_create_double_first_call}
    PRIVATE
    msvcrt.lib
  )
endif()
