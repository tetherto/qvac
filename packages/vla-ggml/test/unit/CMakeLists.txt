find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  test_hparams.cpp
  test_backend_selection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
)

target_compile_options(
  addon-test
  PRIVATE
    -Wno-deprecated
    -Wfatal-errors
    -g)

target_include_directories(
  addon-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_compile_features(addon-test PRIVATE cxx_std_20)

target_link_libraries(
  addon-test
  PRIVATE
    ggml::ggml
    GTest::gtest
    GTest::gtest_main
    GTest::gmock_main
)

add_test(NAME SmolvlaUnit COMMAND addon-test)
set_tests_properties(SmolvlaUnit PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 120)
