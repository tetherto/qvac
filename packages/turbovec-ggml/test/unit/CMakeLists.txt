find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  test_vector_index.cpp
  ${CMAKE_SOURCE_DIR}/addon/VectorIndex.cpp
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

# Stage qvac__fabric-<host>@0.bare next to the binary, set the rpath, and link the
# win32 delay-load helper. See qvac-addon.cmake for the details.
qvac_addon_stage_fabric_for_test(addon-test ${qvac_fabric_target})

# AddressSanitizer on the test executable, kept in a deliberately LIMITED form:
# the shipped fabric prebuild it loads is not ASan-instrumented. See
# packages/classification-ggml/test/unit/CMakeLists.txt for the full rationale.
# scripts/run-cpp-tests.js sets the matching ASAN_OPTIONS.
if(NOT WIN32)
  target_link_libraries(addon-test PRIVATE -fsanitize=address)
endif()

add_test(NAME TurbovecGgmlUnit COMMAND addon-test)
set_tests_properties(TurbovecGgmlUnit PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 300)
