find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  test_rpc_server_core.cpp
  ${CMAKE_SOURCE_DIR}/addon/rpc-server-core.cpp
)

target_include_directories(addon-test PRIVATE ${CMAKE_SOURCE_DIR}/addon)

target_compile_features(addon-test PRIVATE cxx_std_20)

target_link_libraries(
  addon-test
  PRIVATE
    qvac-fabric::headers
    ${qvac_fabric_target}_module
    GTest::gtest
    GTest::gtest_main
)

# GGML_BACKEND_DL/DIR, copy qvac__fabric@0.bare + backends next to the binary,
# rpath, and the win32 delay-load helper. See qvac-addon.cmake for the details.
qvac_addon_stage_fabric_for_test(addon-test ${qvac_fabric_target})

add_test(NAME GgmlRpcServerUnit COMMAND addon-test)
set_tests_properties(GgmlRpcServerUnit PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 300)
