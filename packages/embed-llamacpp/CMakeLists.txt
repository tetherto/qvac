cmake_minimum_required(VERSION 3.25)

option(ANDROID_STL "Android STL linkage" c++_shared)
option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

option(VK_PROFILING "Force vk performance logging in qvac-fabric" OFF)
if(VK_PROFILING)
  list(APPEND VCPKG_MANIFEST_FEATURES "vk-profiling")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(embed-llamacpp C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")
# llama-targets.cmake transitively requires OpenSSL::SSL via cpp-httplib's
# IMPORTED interface. Make OpenSSL discoverable before find_package(llama)
# so the target chain resolves on local builds.
find_package(OpenSSL)
find_package(ggml CONFIG REQUIRED)
find_package(llama CONFIG REQUIRED)

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

# Install dynamic libs to prebuild folder
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()  

add_bare_module(embed-llamacpp EXPORTS ${BACKEND_DL_LIBS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${embed-llamacpp}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${embed-llamacpp}
  PRIVATE
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/vector-index-binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/utils.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/BackendSelection.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/logging.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/BertModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/VectorIndex.cpp
)
target_include_directories(
  ${embed-llamacpp}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

if(TARGET llama AND NOT TARGET llama::llama)
  add_library(llama::llama ALIAS llama)
endif()
if(NOT TARGET llama::common)
  if(TARGET llama::llama-common)
    add_library(llama::common ALIAS llama::llama-common)
  elseif(TARGET llama-common)
    add_library(llama::common ALIAS llama-common)
  else()
    find_library(LLAMA_COMMON_LIB
      NAMES llama-common
      REQUIRED
      HINTS ${LLAMA_LIB_DIR}
      NO_CMAKE_FIND_ROOT_PATH)
    add_library(llama-common UNKNOWN IMPORTED)
    set_target_properties(llama-common
      PROPERTIES
        IMPORTED_LOCATION "${LLAMA_COMMON_LIB}"
        INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_INCLUDE_DIR}"
        INTERFACE_LINK_LIBRARIES "llama::llama")
    add_library(llama::common ALIAS llama-common)
  endif()
endif()

if(TARGET ggml::ggml-vector-index)
  set(QVAC_VECTOR_INDEX_TARGET ggml::ggml-vector-index)
elseif(TARGET ggml::vector-index)
  set(QVAC_VECTOR_INDEX_TARGET ggml::vector-index)
elseif(TARGET ggml-vector-index)
  set(QVAC_VECTOR_INDEX_TARGET ggml-vector-index)
else()
  message(FATAL_ERROR "qvac-fabric did not export a ggml vector-index target")
endif()

target_link_libraries(
  ${embed-llamacpp}
  PRIVATE
    llama::llama llama::common ${QVAC_VECTOR_INDEX_TARGET}
)

target_compile_definitions(${embed-llamacpp} PUBLIC JS_LOGGER)

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building embed-llamacpp with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

target_compile_definitions(${embed-llamacpp} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  
  add_subdirectory(test/unit)
endif()
