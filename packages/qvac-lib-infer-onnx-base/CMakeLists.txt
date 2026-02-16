cmake_minimum_required(VERSION 3.20)

option(BUILD_TESTING "Build tests" ON)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

project(qvac-lib-infer-onnx-base
  VERSION 2.0.0
  LANGUAGES CXX)

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)

include(CTest)
include(GNUInstallDirs)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(onnxruntime CONFIG REQUIRED)

add_library(qvac-lib-infer-onnx-base INTERFACE)
target_include_directories(
  qvac-lib-infer-onnx-base
  INTERFACE $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
            $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)
target_link_libraries(qvac-lib-infer-onnx-base INTERFACE onnxruntime::onnxruntime)

install(TARGETS qvac-lib-infer-onnx-base
        EXPORT qvac-lib-infer-onnx-base_Targets
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

include(CMakePackageConfigHelpers)
write_basic_package_version_file("qvac-lib-infer-onnx-baseConfigVersion.cmake"
                                 VERSION ${PROJECT_VERSION}
                                 COMPATIBILITY SameMajorVersion)

configure_package_config_file(
  "${PROJECT_SOURCE_DIR}/cmake/qvac-lib-infer-onnx-baseConfig.cmake.in"
  "${PROJECT_BINARY_DIR}/qvac-lib-infer-onnx-baseConfig.cmake"
  INSTALL_DESTINATION
  ${CMAKE_INSTALL_DATAROOTDIR}/qvac-lib-infer-onnx-base/cmake)

install(EXPORT qvac-lib-infer-onnx-base_Targets
        FILE qvac-lib-infer-onnx-baseTargets.cmake
        NAMESPACE qvac-lib-infer-onnx-base::
        DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/qvac-lib-infer-onnx-base/cmake)

install(FILES "${PROJECT_BINARY_DIR}/qvac-lib-infer-onnx-baseConfig.cmake"
              "${PROJECT_BINARY_DIR}/qvac-lib-infer-onnx-baseConfigVersion.cmake"
        DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/qvac-lib-infer-onnx-base/cmake)

install(DIRECTORY ${PROJECT_SOURCE_DIR}/src/qvac-lib-infer-onnx-base DESTINATION include)

if(BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    enable_testing()

    # Unit tests: ORT-free (config, tensor types, interface mock)
    add_executable(
        unit_tests
        tests/tensor_types_test.cpp
        tests/config_test.cpp
        tests/interface_test.cpp
    )
    target_include_directories(unit_tests PRIVATE src)
    target_link_libraries(unit_tests PRIVATE GTest::gmock_main)
    gtest_discover_tests(unit_tests)

    # ORT tests: require ONNX Runtime (runtime singleton, type conversions,
    # session options, session integration with test model fixtures)
    add_executable(
        ort_tests
        tests/runtime_test.cpp
        tests/type_conversions_test.cpp
        tests/session_options_test.cpp
        tests/session_test.cpp
    )
    target_include_directories(ort_tests PRIVATE src)
    target_compile_definitions(ort_tests PRIVATE
        TEST_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
    target_link_libraries(ort_tests PRIVATE
        GTest::gmock_main
        qvac-lib-infer-onnx-base)
    gtest_discover_tests(ort_tests)
endif()
