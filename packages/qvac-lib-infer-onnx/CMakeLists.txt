cmake_minimum_required(VERSION 3.20)

option(BUILD_TESTING "Build tests" ON)
option(ENABLE_XNNPACK "Enable XNNPack execution provider" ON)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()
if(ENABLE_XNNPACK)
  list(APPEND VCPKG_MANIFEST_FEATURES "xnnpack")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

project(qvac-onnx
  VERSION 1.0.0
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
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/Logger.hpp")

add_library(qvac-onnx INTERFACE)
target_include_directories(
  qvac-onnx
  INTERFACE $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
            $<BUILD_INTERFACE:${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}>
            $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)
target_link_libraries(qvac-onnx INTERFACE onnxruntime::onnxruntime)

install(TARGETS qvac-onnx
        EXPORT qvac-onnx_Targets
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

include(CMakePackageConfigHelpers)
write_basic_package_version_file("qvac-onnxConfigVersion.cmake"
                                 VERSION ${PROJECT_VERSION}
                                 COMPATIBILITY SameMajorVersion)

configure_package_config_file(
  "${PROJECT_SOURCE_DIR}/cmake/qvac-onnxConfig.cmake.in"
  "${PROJECT_BINARY_DIR}/qvac-onnxConfig.cmake"
  INSTALL_DESTINATION
  ${CMAKE_INSTALL_DATAROOTDIR}/qvac-onnx/cmake)

install(EXPORT qvac-onnx_Targets
        FILE qvac-onnxTargets.cmake
        NAMESPACE qvac-onnx::
        DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/qvac-onnx/cmake)

install(FILES "${PROJECT_BINARY_DIR}/qvac-onnxConfig.cmake"
              "${PROJECT_BINARY_DIR}/qvac-onnxConfigVersion.cmake"
        DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/qvac-onnx/cmake)

install(DIRECTORY ${PROJECT_SOURCE_DIR}/src/qvac-onnx DESTINATION include)

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
        tests/addon_shared_runtime_test.cpp
    )
    target_include_directories(ort_tests PRIVATE src)
    target_compile_definitions(ort_tests PRIVATE
        TEST_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
    target_link_libraries(ort_tests PRIVATE
        GTest::gmock_main
        qvac-onnx)
    gtest_discover_tests(ort_tests)
endif()
