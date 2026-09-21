cmake_minimum_required(VERSION 3.25)

project(ggml_classification_tests LANGUAGES C CXX)

find_package(GTest CONFIG REQUIRED)

option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)

set(TEST_SOURCES
  classification_model_test.cpp
  preprocessor_test.cpp
  backend_env.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ClassificationModel.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ImagePreprocessor.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/MobileNetGraph.cpp
)

add_executable(addon-test ${TEST_SOURCES})
target_compile_features(addon-test PRIVATE cxx_std_20)

target_compile_options(addon-test PRIVATE -Wall -Wextra -Wfatal-errors -g)
target_compile_definitions(addon-test PRIVATE GTEST_HAS_POSIX_RE=0)

# ClassificationModel.cpp references BACKENDS_SUBDIR on its DL load path. The
# addon target defines it, but addon-test compiles that TU separately. The test
# passes an empty backendsDir (backends are preloaded by backend_env), so the
# value is never used at runtime — a placeholder just lets the TU compile.
target_compile_definitions(addon-test PRIVATE BACKENDS_SUBDIR="classification-ggml")

if(NOT WIN32)
  target_compile_options(addon-test PRIVATE -fno-omit-frame-pointer)
endif()

target_include_directories(
  addon-test
  PRIVATE
  ${CMAKE_SOURCE_DIR}/addon/src
  ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  ${STB_INCLUDE_DIRS}
)

target_link_libraries(
  addon-test
  PRIVATE
    qvac-fabric::headers
    ${qvac_fabric_target}_module
    GTest::gtest
    GTest::gtest_main
)

# GGML_BACKEND_DL/DIR, copy qvac__fabric@0.bare + backends next to the binary,
# rpath, and the win32 delay-load helper. See qvac-addon.cmake for the details.
qvac_addon_stage_fabric_for_test(addon-test ${qvac_fabric_target})

if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(addon-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(addon-test PRIVATE -fprofile-instr-generate)
  endif()
endif()

# AddressSanitizer on the test executable, kept in a deliberately LIMITED form.
# addon-test dynamically links the shared @qvac/fabric runtime
# (qvac__fabric@0.bare), and the npm prebuild of it is not ASan-instrumented, so
# nothing fabric does internally is checked and its long-lived runtime globals
# plus its dlopen'd ggml backends look like leaks at exit. A fully ASan-clean
# link would need an ASan-instrumented fabric (QVAC_FABRIC_ASAN=1), which the
# npm prebuild does not ship. So we keep ASan for its heap-overflow /
# use-after-free value on the addon's own code and require the runner to relax
# the checks the module boundary provokes:
#   ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0
# (see .github/workflows/cpp-tests-classification.yml). No LD_PRELOAD is needed
# because the ASan runtime is linked directly into this executable and
# initializes before the fabric module loads.
#
# On Linux operator new/delete are no longer duplicated across the boundary:
# fabric exports them and this binary links -nostdlib++ (see
# qvac_addon_import_fabric_cxx_runtime), so ASan's operators — defined in this
# executable, which the dynamic loader searches first — serve both sides.
# alloc_dealloc_mismatch stays relaxed as a backstop for the other platforms and
# for allocations fabric makes before ASan is ready.
if(NOT WIN32)
  target_link_libraries(addon-test PRIVATE -fsanitize=address)
endif()

add_test(NAME ClassificationModelTests COMMAND addon-test)
set_tests_properties(ClassificationModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 600)
