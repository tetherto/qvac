cmake_minimum_required(VERSION 3.25)

find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  chat_protocol_test.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/protocol/ChatProtocol.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/http/HttpClient.cpp
)

target_compile_features(addon-test PRIVATE cxx_std_20)
target_compile_options(addon-test PRIVATE -Wall -Wextra -Werror)
target_include_directories(
  addon-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src
)
target_link_libraries(
  addon-test
  PRIVATE
    GTest::gtest
    GTest::gtest_main
)
qvac_addon_static_cxx_runtime(addon-test)

add_test(NAME LlmSglangProtocolTests COMMAND addon-test)
set_tests_properties(LlmSglangProtocolTests PROPERTIES TIMEOUT 60)
