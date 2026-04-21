find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  test_hello.cpp
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
    GTest::gtest
    GTest::gtest_main
    GTest::gmock_main
)

add_test(NAME HelloUnit COMMAND addon-test)
set_tests_properties(HelloUnit PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 120)
