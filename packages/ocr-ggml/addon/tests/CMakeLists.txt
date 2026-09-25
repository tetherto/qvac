find_package(GTest CONFIG REQUIRED)

# Exercise production selection against a deterministic raw registry. No models
# or physical GPUs are needed; GGML calls are supplied by the test fixture.
add_executable(addon-test
  ocr_backend_selection_test.cpp
  ocr_tensor_validation_test.cpp
  ../src/model-interface/OcrBackendSelection.cpp
)
target_compile_features(addon-test PRIVATE cxx_std_20)
target_include_directories(addon-test PRIVATE ../src)
target_link_libraries(addon-test PRIVATE qvac-fabric::headers GTest::gtest_main)
add_test(NAME OcrBackendSelection COMMAND addon-test)

add_executable(ocr-prediction-bias-gguf-test
  ocr_prediction_bias_gguf_test.cpp
  ../src/model-interface/easyocr/gguf_loader.cpp
)
target_compile_features(ocr-prediction-bias-gguf-test PRIVATE cxx_std_20)
target_include_directories(ocr-prediction-bias-gguf-test PRIVATE ../src)
target_link_libraries(ocr-prediction-bias-gguf-test PRIVATE
  qvac-fabric::headers ${qvac_fabric_target}_module GTest::gtest_main)
qvac_addon_stage_fabric_for_test(ocr-prediction-bias-gguf-test ${qvac_fabric_target})
add_test(NAME OcrPredictionBiasGguf COMMAND ocr-prediction-bias-gguf-test)
