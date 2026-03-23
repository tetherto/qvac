cmake_minimum_required(VERSION 3.20)

option(BUILD_TESTING "Build tests" ON)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

project(qvac-lib-inference-addon-cpp
  VERSION 1.1.3
  LANGUAGES CXX)

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/qvac-lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

include(CTest)
include(GNUInstallDirs)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(qvac-lib-inference-addon-cpp INTERFACE)
target_include_directories(
  qvac-lib-inference-addon-cpp
  INTERFACE $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
            $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)

install(TARGETS qvac-lib-inference-addon-cpp
        EXPORT qvac-lib-inference-addon-cpp_Targets
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

include(CMakePackageConfigHelpers)
write_basic_package_version_file("qvac-lib-inference-addon-cppConfigVersion.cmake"
                                 VERSION ${PROJECT_VERSION}
                                 COMPATIBILITY SameMajorVersion)

configure_package_config_file(
  "${PROJECT_SOURCE_DIR}/cmake/qvac-lib-inference-addon-cppConfig.cmake.in"
  "${PROJECT_BINARY_DIR}/qvac-lib-inference-addon-cppConfig.cmake"
  INSTALL_DESTINATION
  ${CMAKE_INSTALL_DATAROOTDIR}/qvac-lib-inference-addon-cpp/cmake)

install(EXPORT qvac-lib-inference-addon-cpp_Targets
        FILE qvac-lib-inference-addon-cppTargets.cmake
        NAMESPACE qvac-lib-inference-addon-cpp::
        DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/qvac-lib-inference-addon-cpp/cmake)

install(FILES "${PROJECT_BINARY_DIR}/qvac-lib-inference-addon-cppConfig.cmake"
              "${PROJECT_BINARY_DIR}/qvac-lib-inference-addon-cppConfigVersion.cmake"
        DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/qvac-lib-inference-addon-cpp/cmake)

install(DIRECTORY ${PROJECT_SOURCE_DIR}/src/qvac-lib-inference-addon-cpp DESTINATION include)

if(BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    enable_testing()

    add_executable(
        unit_tests
        tests/blob_stream_test.cpp
        tests/utils_test.cpp
        tests/js_utils_test.cpp
        tests/js_output_handler_test.cpp
        tests/helpers/stream_buffers.cpp
        tests/cpp_output_handler_test.cpp
        tests/simple_addon_test.cpp
        tests/batched_addon_test.cpp
        tests/job_runner_test.cpp
        tests/addon_js_test.cpp
    )
    target_include_directories(unit_tests PRIVATE src tests/helpers_header)
    target_link_libraries(unit_tests PRIVATE GTest::gmock_main)
    gtest_discover_tests(unit_tests)
endif()
