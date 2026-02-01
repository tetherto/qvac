cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

project(
  qvac-lib-infer-onnx-vad
  VERSION 0.4.6
  LANGUAGES C CXX)

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/qvac-lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/Addon.hpp")

add_bare_module(qvac-lib-infer-onnx-vad EXPORTS)

if(WIN32)
  add_definitions( -DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI )
endif()

add_subdirectory(${PROJECT_SOURCE_DIR}/addon/model-interface) # Core lib is built here

target_sources(
  ${qvac-lib-infer-onnx-vad}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/addon/Addon.cpp
    ${PROJECT_SOURCE_DIR}/addon/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/js-interface/qvac-lib-infer-onnx-vad.cpp
)

target_include_directories(
  ${qvac-lib-infer-onnx-vad}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon
)

target_link_libraries(
  ${qvac-lib-infer-onnx-vad}
  PRIVATE
    silero_vad
)

if(WIN32)
  target_compile_options(${qvac-lib-infer-onnx-vad} PRIVATE "/utf-8")
  target_compile_definitions(${qvac-lib-infer-onnx-vad} PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX NOGDI)

  target_link_libraries(
    ${qvac-lib-infer-onnx-vad}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    enable_testing()

    add_executable(unit_tests test/unit/vad_iterator_test.cpp)
    target_include_directories(unit_tests PRIVATE addon)
    target_link_libraries(unit_tests PRIVATE silero_vad GTest::gmock_main)
    gtest_discover_tests(unit_tests)
endif()
