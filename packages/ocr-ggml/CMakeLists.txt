cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(ocr-ggml LANGUAGES C CXX)

qvac_addon_project_setup(VALGRIND_SUPP PRE_COMMIT_HOOK)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/BlobsStream.hpp")

find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)
message(STATUS "ocr-ggml: OpenCV ${OpenCV_VERSION} from ${OpenCV_DIR}")

# ggml runtime is the shared @qvac/fabric prebuild (dynamically linked, loaded
# once per process); sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

add_bare_module(ocr-ggml EXPORTS)

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

target_link_libraries(
  ${ocr-ggml}
  PRIVATE
    ${OpenCV_LIBS}
)
qvac_addon_link_fabric(${ocr-ggml} ${qvac_fabric_target})
qvac_addon_finalize(${ocr-ggml} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(ANDROID)
  target_link_libraries(${ocr-ggml} PRIVATE log)
endif()

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(addon/tests)
endif()
