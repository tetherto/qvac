cmake_minimum_required(VERSION 3.25)

# Include config file to override options (must be before option() calls)
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
  include(${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
endif()

option(BUILD_TESTING "Build tests" OFF)
option(USE_BERGAMOT "Enable Bergamot backend support" ON)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")
set(VCPKG_INSTALL_OPTIONS --clean-after-build)

# Android STL configuration must be set before project()
if(DEFINED ENV{ANDROID_NDK} OR DEFINED ENV{ANDROID_NDK_HOME})
  set(ANDROID_STL c++_shared)
endif()

project(qvac-lib-infer-nmtcpp
  LANGUAGES C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/qvac-lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

set(CMAKE_CXX_STANDARD 20)

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

message(STATUS ${CMAKE_CXX_COMPILER_ID})
if(WIN32)
  add_definitions( -DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI )
endif()

# Required by Tokenizers
if(ANDROID)
  set(ANDROID_TOOLCHAIN_ROOT "$ENV{ANDROID_TOOLCHAIN_ROOT}")
  set(ANDROID_NATIVE_API_LEVEL "$ENV{ANDROID_NATIVE_API_LEVEL}")
endif()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/BlobsStream.hpp")

find_package(ggml CONFIG REQUIRED)
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

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building qvac-lib-infer-nmtcpp with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()

add_bare_module(qvac-lib-infer-nmtcpp EXPORTS ${BACKEND_DL_LIBS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${qvac-lib-infer-nmtcpp}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${qvac-lib-infer-nmtcpp}
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
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bergamot.cpp
  )
endif()
target_include_directories(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

if("${CMAKE_SYSTEM_PROCESSOR}" MATCHES "^(arm|aarch64|ARM64)")
  target_compile_definitions(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
    ARM FMA SSE
  )
endif()

target_compile_definitions(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    JS_LOGGER
)

target_compile_definitions(${qvac-lib-infer-nmtcpp} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

# Add bergamot compile definition if enabled
if(USE_BERGAMOT)
  target_compile_definitions(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      HAVE_BERGAMOT
  )
endif()

if(DEFINED SENTENCEPIECE_INCLUDE_DIRS)
  target_include_directories(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${SENTENCEPIECE_INCLUDE_DIRS}
  )
endif()

# Link core dependencies
target_link_libraries(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    ggml::ggml
)

# When using Bergamot, we configured SPM_PROTOBUF_PROVIDER=package, which means sentencepiece
# uses external protobuf (from vcpkg) instead of its built-in protobuf-lite.
# Therefore, we must link vcpkg's protobuf to provide the protobuf symbols.
# Note: Bergamot includes its own sentencepiece, so we don't link vcpkg's sentencepiece.
if(USE_BERGAMOT)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      protobuf::libprotobuf
  )
else()
  # When NOT using Bergamot, link vcpkg's sentencepiece and protobuf
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${SENTENCEPIECE_TARGET}
      protobuf::libprotobuf
  )
endif()

if(absl_FOUND)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      absl::flags
      absl::flags_internal
  )
endif()

# Link bergamot library if enabled
if(USE_BERGAMOT)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      bergamot-translator::bergamot-translator
  )
endif()

if(WIN32)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(addon/tests)
endif()


