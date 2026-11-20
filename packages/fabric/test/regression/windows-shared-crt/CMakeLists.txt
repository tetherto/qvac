cmake_minimum_required(VERSION 3.25)

# Standalone experiment. Do not change the production triplets or the /MTd
# duplication baseline while evaluating shared-runtime ownership and packaging.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
project(qvac_windows_shared_crt LANGUAGES C CXX)
if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "This experiment requires Windows and an MSVC-compatible compiler")
endif()
if(NOT CMAKE_BUILD_TYPE MATCHES "^(Debug|Release)$")
  message(FATAL_ERROR "Use a single-config Debug or Release build")
endif()
include(CTest)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(QVAC_FABRIC_SOURCE_DIR "" CACHE PATH "Checkout of the shared-core fabric source fork")
if(NOT EXISTS "${QVAC_FABRIC_SOURCE_DIR}/ggml/src/shared-core-runtime.cmake")
  message(FATAL_ERROR "QVAC_FABRIC_SOURCE_DIR must name the shared-core source checkout")
endif()
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_VECTOR_INDEX ON CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_CCACHE OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
set(LLAMA_MTMD ON CACHE BOOL "" FORCE)
foreach(feature OPENSSL BUILD_TESTS BUILD_TOOLS BUILD_EXAMPLES BUILD_SERVER BUILD_APP)
  set(LLAMA_${feature} OFF CACHE BOOL "" FORCE)
endforeach()
add_subdirectory("${QVAC_FABRIC_SOURCE_DIR}" fabric)

set(native "${CMAKE_CURRENT_SOURCE_DIR}/../../native")
# Match fabric's archive ownership and link pressure, including common's STL
# instantiations. This is a DLL link control, not a replacement Bare addon.
add_library(fabric_runtime_probe SHARED "${native}/runtime-probe.cpp")
target_link_libraries(fabric_runtime_probe PRIVATE
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,llama>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,llama-common>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,mtmd>"
  ggml-vector-index)
add_executable(runtime_boundary "${native}/runtime.cpp")
target_link_libraries(runtime_boundary PRIVATE fabric_runtime_probe ggml-base)
add_test(NAME shared-cxx-runtime COMMAND runtime_boundary)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  # Keep the original allocation probe's Debug-CRT requirement intact.
  add_executable(boundary "${native}/boundary.cpp")
  target_compile_features(boundary PRIVATE cxx_std_17)
  target_link_libraries(boundary PRIVATE ggml)
  add_library(callback_probe MODULE "${native}/callback-probe.cpp")
  target_link_libraries(callback_probe PRIVATE ggml-base)
  add_test(NAME backend-allocation COMMAND boundary allocation "$<TARGET_FILE:ggml-cpu>")
  add_test(NAME module-logger COMMAND boundary logger "$<TARGET_FILE:callback_probe>")
  add_test(NAME module-abort COMMAND ${CMAKE_COMMAND}
    "-DPROGRAM=$<TARGET_FILE:boundary>" "-DMODULE=$<TARGET_FILE:callback_probe>"
    -P "${native}/expect-abort-callback.cmake")
  set_tests_properties(backend-allocation module-logger module-abort PROPERTIES TIMEOUT 30)
  # Catch assertions at process/DLL teardown as well as during the test body.
  include("${CMAKE_CURRENT_SOURCE_DIR}/../windows-stream/hook.cmake")
else()
  # Release runtime DLLs are redistributable; Debug runtime DLLs are not.
  # MSVC_REDIST_DIR can select the redistribution directory for the toolset.
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_SKIP TRUE)
  set(CMAKE_INSTALL_DEBUG_LIBRARIES FALSE)
  include(InstallRequiredSystemLibraries)
  if(NOT CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
    message(FATAL_ERROR "No redistributable CRT DLLs found; set MSVC_REDIST_DIR")
  endif()
  file(MAKE_DIRECTORY "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
  file(COPY ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS} DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
  install(FILES ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS} DESTINATION bin COMPONENT crt-experiment)
  target_sources(runtime_boundary PRIVATE windows-runtime.cpp)
  target_compile_definitions(runtime_boundary PRIVATE QVAC_TEST_APPLOCAL_CRT)
  install(TARGETS runtime_boundary fabric_runtime_probe
    ggml-base ggml ggml-vector-index ggml-cpu
    RUNTIME DESTINATION bin COMPONENT crt-experiment
    LIBRARY DESTINATION bin COMPONENT crt-experiment)
endif()
set_tests_properties(shared-cxx-runtime PROPERTIES TIMEOUT 30)
