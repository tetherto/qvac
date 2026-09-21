cmake_minimum_required(VERSION 3.25)

# Include config file to override options (must be before option() calls).
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
  include(${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
endif()

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()
option(USE_BERGAMOT "Enable Bergamot backend support" ON)
# Off by default: Adreno 830 ggml-opencl M%4 assertion (QVAC-17790)
option(USE_OPENCL "Prefer/allow OpenCL backend for GPU inference" OFF)

project(translation-nmtcpp
  LANGUAGES C CXX)

qvac_addon_project_setup(VALGRIND_SUPP PRE_COMMIT_HOOK)

# Required by Tokenizers
if(ANDROID)
  set(ANDROID_TOOLCHAIN_ROOT "$ENV{ANDROID_TOOLCHAIN_ROOT}")
  set(ANDROID_NATIVE_API_LEVEL "$ENV{ANDROID_NATIVE_API_LEVEL}")
endif()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/BlobsStream.hpp")

find_package(absl CONFIG QUIET)
find_package(protobuf CONFIG REQUIRED)

if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
  find_package(Iconv REQUIRED)
endif()

find_package(PkgConfig QUIET)

find_package(sentencepiece CONFIG QUIET)
if(sentencepiece_FOUND)
  set(SENTENCEPIECE_TARGET sentencepiece::sentencepiece)
elseif(NOT WIN32)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(sentencepiece REQUIRED IMPORTED_TARGET sentencepiece)
  set(SENTENCEPIECE_TARGET PkgConfig::sentencepiece)
else()
  find_path(SENTENCEPIECE_INCLUDE_DIR
    NAMES sentencepiece_processor.h
    PATHS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES include
  )

  find_library(SENTENCEPIECE_LIBRARY
    NAMES sentencepiece
    PATHS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
  )

  if(USE_BERGAMOT)
    find_library(SENTENCEPIECE_TRAIN_LIBRARY
	NAMES sentencepiece_train
    	PATHS ${CMAKE_PREFIX_PATH}
    	PATH_SUFFIXES lib
    )
  endif(USE_BERGAMOT)

  if(SENTENCEPIECE_INCLUDE_DIR AND SENTENCEPIECE_LIBRARY)
    add_library(sentencepiece::sentencepiece UNKNOWN IMPORTED)
    set_target_properties(sentencepiece::sentencepiece PROPERTIES
      IMPORTED_LOCATION "${SENTENCEPIECE_LIBRARY}"
      INTERFACE_INCLUDE_DIRECTORIES "${SENTENCEPIECE_INCLUDE_DIR}"
    )

    if(USE_BERGAMOT)
      if(SENTENCEPIECE_TRAIN_LIBRARY)
        set_property(TARGET sentencepiece::sentencepiece APPEND PROPERTY
	INTERFACE_LINK_LIBRARIES "${SENTENCEPIECE_TRAIN_LIBRARY}"
      )
      endif(SENTENCEPIECE_TRAIN_LIBRARY)
    endif(USE_BERGAMOT)

    set(SENTENCEPIECE_TARGET sentencepiece::sentencepiece)
    set(SENTENCEPIECE_INCLUDE_DIRS "${SENTENCEPIECE_INCLUDE_DIR}")
  else()
    if(PkgConfig_FOUND)
      pkg_check_modules(sentencepiece QUIET IMPORTED_TARGET sentencepiece)
      if(sentencepiece_FOUND)
        set(SENTENCEPIECE_TARGET PkgConfig::sentencepiece)
      else()
        message(FATAL_ERROR "sentencepiece not found. Please install it via vcpkg.")
      endif()
    else()
      message(FATAL_ERROR "sentencepiece not found. Please install it via vcpkg.")
    endif()
  endif()
endif()

# Configure and add bergamot-translator if enabled
if(USE_BERGAMOT)
  find_package(bergamot-translator CONFIG REQUIRED)
endif()

# ggml runtime is the shared @qvac/fabric prebuild (dynamically linked, loaded
# once per process); sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

add_bare_module(translation-nmtcpp EXPORTS)

target_sources(
  ${translation-nmtcpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TranslationModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/PivotTranslationModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_tokenization.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_state_backend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_loader.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_graph_decoder.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_graph_encoder.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_beam_search.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_utils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/NmtLazyInitializeBackend.cpp
)

# Add bergamot source files if enabled
if(USE_BERGAMOT)
  target_sources(
    ${translation-nmtcpp}
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bergamot.cpp
  )
endif()
target_include_directories(
  ${translation-nmtcpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

if("${CMAKE_SYSTEM_PROCESSOR}" MATCHES "^(arm|aarch64|ARM64)")
  target_compile_definitions(
    ${translation-nmtcpp}
    PRIVATE
    ARM FMA SSE
  )
endif()

# Add bergamot compile definition if enabled
if(USE_BERGAMOT)
  target_compile_definitions(
    ${translation-nmtcpp}
    PRIVATE
      HAVE_BERGAMOT
  )
endif()

if(USE_OPENCL)
  target_compile_definitions(
    ${infer-nmtcpp}
    PRIVATE
      QVAC_NMTCPP_USE_OPENCL
  )
endif()

if(DEFINED SENTENCEPIECE_INCLUDE_DIRS)
  target_include_directories(
    ${translation-nmtcpp}
    PRIVATE
      ${SENTENCEPIECE_INCLUDE_DIRS}
  )
endif()

qvac_addon_link_fabric(${translation-nmtcpp} ${qvac_fabric_target})

# When using Bergamot, we configured SPM_PROTOBUF_PROVIDER=package, which means sentencepiece
# uses external protobuf (from vcpkg) instead of its built-in protobuf-lite.
# Therefore, we must link vcpkg's protobuf to provide the protobuf symbols.
# Note: Bergamot includes its own sentencepiece, so we don't link vcpkg's sentencepiece.
if(USE_BERGAMOT)
  target_link_libraries(
    ${translation-nmtcpp}
    PRIVATE
      protobuf::libprotobuf
  )
else()
  # When NOT using Bergamot, link vcpkg's sentencepiece and protobuf
  target_link_libraries(
    ${translation-nmtcpp}
    PRIVATE
      ${SENTENCEPIECE_TARGET}
      protobuf::libprotobuf
  )
endif()

if(absl_FOUND)
  target_link_libraries(
    ${translation-nmtcpp}
    PRIVATE
      absl::flags
      absl::flags_internal
  )
endif()

# Link bergamot library if enabled
if(USE_BERGAMOT)
  target_link_libraries(
    ${translation-nmtcpp}
    PRIVATE
      bergamot-translator::bergamot-translator
  )
endif()

qvac_addon_finalize(${translation-nmtcpp} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(addon/tests)
endif()


