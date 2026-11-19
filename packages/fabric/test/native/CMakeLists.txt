cmake_minimum_required(VERSION 3.25)

# Configure independently: these tests must not change shipped artifacts.
if(CMAKE_HOST_WIN32)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
project(ggml_boundary_tests LANGUAGES C CXX)
include(CTest)
option(BUILD_SHARED_LIBS "Build the tested core shared (use OFF for the duplication baseline)" OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

set(QVAC_GGML_SOURCE_DIR "" CACHE PATH "Exact ggml source used by the backend build (optional)")
set(QVAC_TEST_BACKEND "" CACHE FILEPATH "Real backend module to exercise")
option(QVAC_TEST_LIBCXX "Use QVAC's Linux libc++ toolchain" ON)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND QVAC_TEST_LIBCXX)
  add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-stdlib=libc++>)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

if(QVAC_GGML_SOURCE_DIR)
  # Small real CPU build, including a /MTd backend on Windows. GPU/package
  # tests instead use find_package and QVAC_TEST_BACKEND below.
  set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(GGML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
  set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
  set(GGML_CPU_ALL_VARIANTS OFF CACHE BOOL "" FORCE)
  set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
  set(GGML_CCACHE OFF CACHE BOOL "" FORCE)
  add_subdirectory("${QVAC_GGML_SOURCE_DIR}" ggml)
  set(core ggml-base)
  set(registry ggml)
  if(NOT QVAC_TEST_BACKEND)
    set(QVAC_TEST_BACKEND "$<TARGET_FILE:ggml-cpu>")
  endif()
else()
  find_package(ggml CONFIG REQUIRED)
  set(core ggml::ggml-base)
  set(registry ggml::ggml)
endif()
if(NOT QVAC_TEST_BACKEND)
  message(FATAL_ERROR "Set QVAC_TEST_BACKEND to a real CPU/GPU module; no fallback is tested")
endif()

add_executable(boundary boundary.cpp)
target_compile_features(boundary PRIVATE cxx_std_17)
target_link_libraries(boundary PRIVATE ${registry} ${CMAKE_DL_LIBS})

# A deterministic callback emitter, linked to the SAME core target as real
# backends. This is a fixture, not a replacement allocator/backend.
add_library(callback_probe MODULE callback-probe.cpp)
target_link_libraries(callback_probe PRIVATE ${core})
if(UNIX AND NOT APPLE)
  target_link_options(callback_probe PRIVATE
    "LINKER:--version-script=${CMAKE_CURRENT_SOURCE_DIR}/probe.map")
  set_property(TARGET callback_probe APPEND PROPERTY LINK_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/probe.map")
endif()

add_test(NAME backend-allocation COMMAND boundary allocation "${QVAC_TEST_BACKEND}")
add_test(NAME module-logger COMMAND boundary logger "$<TARGET_FILE:callback_probe>")
add_test(NAME module-abort COMMAND ${CMAKE_COMMAND}
  "-DPROGRAM=$<TARGET_FILE:boundary>" "-DMODULE=$<TARGET_FILE:callback_probe>"
  -P "${CMAKE_CURRENT_SOURCE_DIR}/expect-abort-callback.cmake")
set_tests_properties(backend-allocation module-logger module-abort PROPERTIES TIMEOUT 30)

if(MSVC)
  # Release-only packages cannot establish Debug CRT ownership. Never silently
  # treat an imported Release archive as a /MTd regression run.
  if(NOT QVAC_GGML_SOURCE_DIR)
    message(FATAL_ERROR "Windows CRT coverage requires QVAC_GGML_SOURCE_DIR and a Debug build")
  endif()
endif()
