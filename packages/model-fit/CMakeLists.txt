cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(model-fit LANGUAGES C CXX)

qvac_addon_project_setup()

# Header-only JS<->C++ marshalling helpers (JsArgsParser / jsu / JSCATCH).
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")

# llama.cpp + ggml are supplied by @qvac/fabric's shared bare runtime. This
# also derives BACKENDS_SUBDIR_VALUE from Fabric's companion backend directory.
qvac_addon_use_fabric()

add_bare_module(model-fit EXPORTS)

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/fit/FitParams.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/fit/FitParamsApplication.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/fit/FitResultContext.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/fit/LlamaLoadConfig.cpp
)

target_sources(${model-fit} PRIVATE ${ADDON_SOURCES})

target_include_directories(
  ${model-fit}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

# The fitter lives in Fabric's exported libcommon surface as well as its llama
# ABI, so compile against Fabric headers and dynamically link its one runtime.
qvac_addon_link_fabric(${model-fit} ${qvac_fabric_target})
qvac_addon_finalize(${model-fit} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  enable_testing()

  add_executable(
    model-fit-context-test
    test/unit/FitResultContext.test.cpp
    addon/src/fit/FitResultContext.cpp
  )
  target_include_directories(model-fit-context-test PRIVATE ${PROJECT_SOURCE_DIR}/addon/src)
  target_compile_features(model-fit-context-test PRIVATE cxx_std_17)
  target_link_libraries(
    model-fit-context-test
    PRIVATE
      qvac-fabric::headers
      ${qvac_fabric_target}_module
  )
  qvac_addon_stage_fabric_for_test(model-fit-context-test ${qvac_fabric_target})
  add_test(NAME ModelFitContextUnit COMMAND model-fit-context-test)

  add_executable(
    model-fit-params-application-test
    test/unit/FitParamsApplication.test.cpp
    addon/src/fit/FitParamsApplication.cpp
  )
  target_include_directories(
    model-fit-params-application-test
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src
  )
  target_compile_features(model-fit-params-application-test PRIVATE cxx_std_17)
  target_link_libraries(
    model-fit-params-application-test
    PRIVATE
      qvac-fabric::headers
      ${qvac_fabric_target}_module
  )
  qvac_addon_stage_fabric_for_test(
    model-fit-params-application-test ${qvac_fabric_target})
  add_test(NAME ModelFitParamsApplicationUnit COMMAND model-fit-params-application-test)

  add_executable(
    model-fit-llama-load-config-test
    test/unit/LlamaLoadConfig.test.cpp
    addon/src/fit/LlamaLoadConfig.cpp
  )
  target_include_directories(
    model-fit-llama-load-config-test
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src
  )
  target_compile_features(model-fit-llama-load-config-test PRIVATE cxx_std_20)
  target_link_libraries(
    model-fit-llama-load-config-test
    PRIVATE
      qvac-fabric::headers
      ${qvac_fabric_target}_module
  )
  qvac_addon_stage_fabric_for_test(
    model-fit-llama-load-config-test ${qvac_fabric_target})
  if(APPLE)
    target_link_libraries(model-fit-llama-load-config-test PRIVATE objc)
    target_link_options(model-fit-llama-load-config-test PRIVATE -fuse-ld=/usr/bin/ld)
  endif()
  add_test(NAME ModelFitLlamaLoadConfigUnit COMMAND model-fit-llama-load-config-test)
endif()

# NOTE: do not link msvcrt.lib here. It is the *dynamic* CRT import library, and
# the monorepo ships Windows addons against the static runtime (QVAC-21100) so a
# prebuild carries no vcruntime140/ucrtbase dependency. The CRT comes from the
# vcpkg triplet (vcpkg-overlays/triplets/x64-windows.cmake, VCPKG_CRT_LINKAGE
# static) and the bare-make toolchain; naming it explicitly here overrode both.
# reusable-prebuilds.yml fails the win32 prebuild if those imports reappear.
