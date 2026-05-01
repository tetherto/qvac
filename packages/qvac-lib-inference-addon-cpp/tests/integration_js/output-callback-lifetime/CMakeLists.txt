cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(
  output_callback_lifetime
  VERSION 0.1.0
  LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_bare_module(output_callback_lifetime EXPORTS)

target_sources(
  ${output_callback_lifetime}
  PRIVATE
  binding.cpp
)

target_include_directories(
  ${output_callback_lifetime}
  PRIVATE
  ../../../src
)

if(WIN32)
  target_compile_definitions(
    ${output_callback_lifetime}
    PRIVATE
    NOMINMAX
    WIN32_MEAN_AND_LEAN
    NOGDI
  )

  target_compile_options(${output_callback_lifetime} PRIVATE "/utf-8")

  target_link_libraries(
    ${output_callback_lifetime}
    PRIVATE
    msvcrt.lib
  )
endif()
