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

# Inject the ggml lib dir so backend_env.cpp can preload the DL backend modules
# (libqvac-ggml-*.so live there; ggml's default loader doesn't search it).
target_compile_definitions(
  addon-test PRIVATE GGML_BACKEND_DIR="$<TARGET_FILE_DIR:ggml::ggml>")

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
    ggml::ggml
    ggml::ggml-base
    GTest::gtest
    GTest::gtest_main
)
# ggml::ggml-cpu is a single static target only when CPU variants are off
# (non-DL). Under GGML_BACKEND_DL it's split into dlopen'd modules and the
# target doesn't exist, so link it conditionally.
if(TARGET ggml::ggml-cpu)
  target_link_libraries(addon-test PRIVATE ggml::ggml-cpu)
endif()

if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(addon-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(addon-test PRIVATE -fprofile-instr-generate)
  endif()
endif()

if(NOT WIN32)
  target_link_libraries(addon-test PRIVATE -fsanitize=address)
endif()

if(WIN32)
  target_link_libraries(addon-test PRIVATE msvcrt.lib)
endif()

add_test(NAME ClassificationModelTests COMMAND addon-test)
set_tests_properties(ClassificationModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 600)
