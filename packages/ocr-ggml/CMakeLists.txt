cmake_minimum_required(VERSION 3.25)

# Include config file to override options (must be before option() calls)
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
  include(${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
endif()

option(ANDROID_STL "Android STL linkage" c++_shared)
option(BUILD_TESTING "Build tests" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(ocr-ggml
  LANGUAGES C CXX)

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

# C++20: `std::span` and aggregate-paren-init in lifted post-proc need C++20.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

message(STATUS ${CMAKE_CXX_COMPILER_ID})
if(WIN32)
  add_definitions(-DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI)
endif()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/BlobsStream.hpp")

find_package(ggml CONFIG REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)
message(STATUS "ocr-ggml: OpenCV ${OpenCV_VERSION} from ${OpenCV_DIR}")

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building ocr-ggml with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# Forward every available ggml backend (CPU + GPU dynamic libs) into the
# addon's prebuild folder so bare can load them at runtime — same pattern
# as translation-nmtcpp.
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    # GGML_AVAILABLE_BACKENDS advertises every backend the upstream port
    # knows about, but real CMake targets only exist for those actually
    # built into the installed package (e.g. ggml-vulkan / ggml-opencl
    # are absent on hosts/feature sets without them). Skip missing ones so
    # add_bare_module's get_target_property() doesn't error out. Parity with
    # packages/classification-ggml.
    if(TARGET ggml::${_backend})
      list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
    endif()
  endforeach()
endif()

add_bare_module(ocr-ggml EXPORTS ${BACKEND_DL_LIBS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${ocr-ggml}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

# ------------------------------------------------------------------
# Source files
# ------------------------------------------------------------------
# Source layout under addon/src/:
#   - model-interface/          unified Pipeline IModel adapter (EasyOCR + DocTR via mode)
#   - model-interface/doctr/    DocTR GGML detector + recognizer steps
#   - model-interface/easyocr/  GGUF loader, ops, CRAFT, CRNN weights+inference
#   - model-interface/easyocr/pipeline/  OCR pipeline steps
#   - js-interface/             N-API / bare binding entry point
target_sources(
  ${ocr-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/OcrLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/OcrBackendSelection.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/Pipeline.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/gguf_loader.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/ops.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/craft_weights.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/craft.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/crnn_weights.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/crnn.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/pipeline/steps.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/pipeline/lang.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/pipeline/step_detection_inference.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/pipeline/step_bounding_box.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/easyocr/pipeline/step_recognize_text.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/doctr/MobileNetGraph.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/doctr/StepDoctrDetectionGGML.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/doctr/StepDoctrRecognitionGGML.cpp
)

target_include_directories(
  ${ocr-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${OpenCV_INCLUDE_DIRS}
)

if("${CMAKE_SYSTEM_PROCESSOR}" MATCHES "^(arm|aarch64|ARM64)")
  target_compile_definitions(
    ${ocr-ggml}
    PRIVATE
      ARM FMA SSE
  )
endif()

target_compile_definitions(
  ${ocr-ggml}
  PRIVATE
    JS_LOGGER
)

target_compile_definitions(${ocr-ggml} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

# Mirror vla-ggml: when ggml is built with GGML_BACKEND_DL=ON (Android),
# propagate the flag so pipeline code calls ggml_backend_load_all_from_path
# consistently with the bundled backend modules.
if(GGML_BACKEND_DL)
  target_compile_definitions(${ocr-ggml} PRIVATE GGML_BACKEND_DL)
endif()

target_link_libraries(
  ${ocr-ggml}
  PRIVATE
    ggml::ggml
    ${OpenCV_LIBS}
)
if(ANDROID)
  target_link_libraries(${ocr-ggml} PRIVATE log)
endif()

if(ANDROID)
  target_link_options(
    ${ocr-ggml}_module
    PRIVATE
      -Wl,-z,max-page-size=16384
      -Wl,-z,common-page-size=16384
  )
endif()

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(addon/tests)
endif()
