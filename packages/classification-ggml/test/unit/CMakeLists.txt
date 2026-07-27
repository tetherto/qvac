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

# @qvac/fabric ships the ggml compute backends as GGML_BACKEND_DL modules on
# Linux and Android (the CPU micro-arch variants and Vulkan). Compile the model
# TU with GGML_BACKEND_DL there so it uses the registry API instead of the
# statically-linked ggml_backend_cpu_init() (which lives inside a backend .so
# and is not present in the shared runtime). On macOS/Windows the backends are
# static inside qvac__fabric@0.bare and ggml_backend_cpu_init() links directly.
if((ANDROID OR UNIX) AND NOT APPLE)
  target_compile_definitions(addon-test PRIVATE GGML_BACKEND_DL)
endif()

# backend_env.cpp preloads the ggml DL backend modules from GGML_BACKEND_DIR
# before any test runs. The staged @qvac/fabric backends are copied next to the
# test binary (see below), so point the loader at the binary dir. On
# macOS/Windows the dir has no backend .so files and the static backends inside
# qvac__fabric@0.bare self-register on load.
target_compile_definitions(
  addon-test PRIVATE GGML_BACKEND_DIR="${CMAKE_CURRENT_BINARY_DIR}")

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

if(WIN32)
  # The fabric runtime is delay-loaded: the imported prebuilt module target
  # propagates /DELAYLOAD:qvac__fabric@0.bare but not the delay-load helper.
  # add_bare_module() attaches that helper (bare_delay_load -> delayimp, which
  # provides __delayLoadHelper2) to real .bare modules, but this standalone test
  # executable is a plain add_executable() and never goes through it, so it must
  # link the helper itself. The parent CMakeLists defines bare_delay_load via its
  # add_bare_module(classification-ggml) call before this subdirectory is added.
  target_link_libraries(addon-test PRIVATE bare_delay_load)
endif()

if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(addon-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(addon-test PRIVATE -fprofile-instr-generate)
  endif()
endif()

# AddressSanitizer on the test executable, kept in a deliberately LIMITED form.
# addon-test dynamically links the shared @qvac/fabric runtime
# (qvac__fabric@0.bare), and the shipped fabric prebuild is built with
# -static-libstdc++ (see packages/fabric/CMakeLists.txt). Its module-local
# static libc++ provides fabric's OWN operator new/delete, bound internally by
# the symbols.map `local: *` rule, so allocations made inside fabric bottom out
# at plain malloc while addon-test's operator new/delete resolve to the ASan
# runtime. Any object that crosses the module boundary (new'd on one side,
# delete'd on the other) trips ASan's alloc-dealloc / new-delete mismatch check
# and aborts the run, and fabric's long-lived runtime globals + dlopen'd ggml
# backends look like leaks at exit. A fully ASan-clean link would need an
# ASan-instrumented fabric (QVAC_FABRIC_ASAN=1 -> shared libc++), which the npm
# prebuild does not ship. So we keep ASan for its heap-overflow / use-after-free
# value on the addon's own code and require the CI runner to relax the checks
# the static-libstdc++ boundary provokes:
#   ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0
# (see .github/workflows/cpp-tests-classification.yml). No LD_PRELOAD is needed
# because the ASan runtime is linked directly into this executable and
# initializes before the fabric module loads.
if(NOT WIN32)
  target_link_libraries(addon-test PRIVATE -fsanitize=address)
endif()

# Copy the shared @qvac/fabric runtime next to the test executable so it
# resolves at runtime via the $ORIGIN/@loader_path rpath set below.
add_custom_command(TARGET addon-test POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:${qvac_fabric_target}_module>
    ${CMAKE_CURRENT_BINARY_DIR}/qvac__fabric@0.bare
  COMMENT "Copying qvac__fabric@0.bare to test directory"
)

# On Linux and Android @qvac/fabric builds its ggml compute backends as separate
# shared libraries (GGML_BACKEND_DL): the runtime-dispatched CPU micro-arch
# variants (and Vulkan) are dlopen'd at runtime via
# ggml_backend_load_all_from_path(). backend_env.cpp loads them from
# GGML_BACKEND_DIR (this binary dir), so stage them next to the executable,
# mirroring the production install in the parent CMakeLists. Without them the
# ggml backend registry is empty and every model-loading test fails with "no
# backends are loaded". On macOS/Windows the backends are static inside
# qvac__fabric@0.bare, so the glob is empty and the CPU backend self-registers
# when the runtime loads.
bare_target(host)
file(GLOB _fabric_test_backends
  "${CMAKE_SOURCE_DIR}/node_modules/@qvac/fabric/prebuilds/${host}/qvac__fabric/*.so")
if(_fabric_test_backends)
  add_custom_command(TARGET addon-test POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      ${_fabric_test_backends}
      ${CMAKE_CURRENT_BINARY_DIR}/
    COMMENT "Staging @qvac/fabric ggml backends next to addon-test")
endif()

# The runtime is named qvac__fabric@0.bare (the module SONAME) only in the copy
# beside the test binary, so point the executable's rpath at its own directory.
# Unlike the .bare addon module (which cmake-bare gives an $ORIGIN rpath), this
# plain test executable gets no such rpath by default.
if(APPLE)
  set_target_properties(addon-test PROPERTIES BUILD_RPATH "@loader_path")
elseif(NOT WIN32)
  set_target_properties(addon-test PROPERTIES BUILD_RPATH "$ORIGIN")
endif()

add_test(NAME ClassificationModelTests COMMAND addon-test)
set_tests_properties(ClassificationModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 600)
