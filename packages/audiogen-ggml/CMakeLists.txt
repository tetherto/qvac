cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(audiogen-ggml CXX C)

qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")

# Fuzz-only configure (BUILD_FUZZING without BUILD_TESTING): build just the
# fuzz targets and skip engine find_package() + the .bare module so pure
# parse/transform drivers keep full ASan + LSan.
qvac_addon_fuzz_only_return()

# The ggml runtime is the shared @qvac/fabric prebuild (dynamically linked,
# loaded once per process, its backends found and loaded by fabric itself);
# sets qvac_fabric_target.
qvac_addon_use_fabric()

find_package(audiogen-cpp CONFIG REQUIRED)

# audiogen-cpp was compiled against the same ggml headers; its ggml symbols
# come from the shared runtime, not from the qvac-fabric port's static archives.
qvac_addon_engine_on_fabric(audiogen-cpp::audiogen-cpp)

# The module is named after the platform package that ships it,
# qvac__audiogen-ggml-<suffix> (every iOS host shares `ios`), so that package
# is an ordinary addon: require.addon(), bare-pack and bare-link all find
# prebuilds/<host>/qvac__audiogen-ggml-<suffix>.bare there. Keep the suffix in
# sync with "#host-addon" in package.json and SLICE_DEFINITIONS in
# scripts/ci/slice-platform-packages.mjs.
bare_target(bare_target_value)
if(bare_target_value MATCHES "^ios-")
  set(module_name "qvac__audiogen-ggml-ios")
else()
  set(module_name "qvac__audiogen-ggml-${bare_target_value}")
endif()

add_bare_module(audiogen-ggml NAME ${module_name} EXPORTS)

target_sources(
  ${audiogen-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/acestep/AcestepModel.cpp
)

if(NOT ANDROID AND NOT CMAKE_SYSTEM_NAME STREQUAL "iOS")
  target_sources(
    ${audiogen-ggml}
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/minimax/MinimaxModel.cpp
  )
  target_compile_definitions(${audiogen-ggml} PRIVATE AUDIOGEN_HAS_MINIMAX=1)
endif()

target_include_directories(
  ${audiogen-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${audiogen-ggml}
  PRIVATE
    audiogen-cpp::audiogen-cpp
)

target_compile_definitions(${audiogen-ggml} PUBLIC JS_LOGGER)

qvac_addon_link_fabric(${audiogen-ggml} ${qvac_fabric_target})
qvac_addon_finalize(${audiogen-ggml})

qvac_addon_add_fuzz_subdirectory()
