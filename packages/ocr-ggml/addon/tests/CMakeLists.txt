find_package(GTest CONFIG REQUIRED)

# Exercise production selection against a deterministic raw registry. No models
# or physical GPUs are needed; GGML calls are supplied by the test fixture.
add_executable(addon-test
  ocr_backend_selection_test.cpp
  ../src/model-interface/OcrBackendSelection.cpp
)
target_compile_features(addon-test PRIVATE cxx_std_20)
target_include_directories(addon-test PRIVATE ../src)
target_link_libraries(addon-test PRIVATE qvac-fabric::headers GTest::gtest_main)
add_test(NAME OcrBackendSelection COMMAND addon-test)
