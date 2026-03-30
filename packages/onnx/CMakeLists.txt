cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_XNNPACK "Enable XNNPack execution provider" ON)
option(QVAC_ONNX_ANDROID_LOG "Enable Android logcat debug logging" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

if(ENABLE_XNNPACK)
  list(APPEND VCPKG_MANIFEST_FEATURES "xnnpack")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

if(APPLE OR UNIX)
  SET(VCPKG_OVERLAY_TRIPLETS "vcpkg-override-triplets/triplets")
endif()

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" _pkg_json)
string(JSON _pkg_version GET "${_pkg_json}" "version")

project(qvac-onnx VERSION ${_pkg_version} LANGUAGES C CXX)

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)

include(CTest)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Patch cmake config files for cmake 4.x compatibility
foreach(_cmake4_fix_file
    "${VCPKG_INSTALLED_PATH}/share/onnxruntime/onnxruntimeTargets.cmake"
    "${VCPKG_INSTALLED_PATH}/share/protobuf/protobuf-targets.cmake")
  if(EXISTS "${_cmake4_fix_file}")
    file(READ "${_cmake4_fix_file}" _cmake4_fix_content)
    # Strip LINK_ONLY generator expressions.
    # Use [^";] to exclude " (property value boundary) and ; (entry separator)
    # while still allowing nested genexes like $<$<CONFIG:DEBUG>:Dbghelp>.
    # Build pattern with string(CONCAT) to prevent cmake genex evaluation.
    if(_cmake4_fix_content MATCHES "LINK_ONLY:")
      string(CONCAT _lo_re "\\\\?" "\\$" [=[<LINK_ONLY:([^";]+)>]=])
      string(REGEX REPLACE "${_lo_re}" "\\1"
        _cmake4_fix_content "${_cmake4_fix_content}")
    endif()
    file(WRITE "${_cmake4_fix_file}" "${_cmake4_fix_content}")
  endif()
endforeach()

find_package(unofficial-pthreadpool CONFIG QUIET)
find_package(onnxruntime CONFIG REQUIRED)

add_bare_module(qvac-onnx EXPORTS)

target_sources(${qvac-onnx} PRIVATE addon/binding.cpp)
target_include_directories(${qvac-onnx} PRIVATE src)
target_link_libraries(${qvac-onnx} PRIVATE onnxruntime::onnxruntime_static)

if(QVAC_ONNX_ANDROID_LOG)
  target_compile_definitions(${qvac-onnx} PRIVATE QVAC_ONNX_ENABLE_ANDROID_LOG)
endif()

# Override install_name so that consumers using @loader_path rpath can resolve
# this library as a companion dependency (cmake-bare sets INSTALL_NAME_DIR ""
# which produces a bare filename install_name that dyld cannot resolve via rpath).
if(APPLE)
  set_target_properties(${qvac-onnx}_module PROPERTIES
    INSTALL_NAME_DIR "@rpath"
    BUILD_WITH_INSTALL_NAME_DIR ON)
endif()

# Version script
if(UNIX AND NOT APPLE)
  target_link_options(${qvac-onnx}_module PRIVATE
    -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map)
elseif(APPLE)
  target_link_options(${qvac-onnx}_module PRIVATE
    -Wl,-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/exports.txt)
elseif(WIN32)
  # Use /EXPORT instead of a .def file to avoid overriding the auto-generated
  # exports from WINDOWS_EXPORT_ALL_SYMBOLS (which exports bare_* and napi_*).
  target_link_options(${qvac-onnx}_module PRIVATE
    /EXPORT:OrtGetApiBase)
endif()

# Strip .bare module
if(CMAKE_STRIP AND NOT WIN32)
  if(APPLE)
    set(_strip_flags -x)
  else()
    set(_strip_flags --strip-unneeded)
  endif()
  add_custom_command(
    TARGET ${qvac-onnx}_module POST_BUILD
    COMMAND ${CMAKE_STRIP} ${_strip_flags} $<TARGET_FILE:${qvac-onnx}_module>
    COMMENT "Stripping ${qvac-onnx}_module")
endif()

# --- Export headers and cmake config for consumer addons ---
add_library(qvac-onnx-headers INTERFACE)
set_target_properties(qvac-onnx-headers PROPERTIES EXPORT_NAME headers)
target_include_directories(qvac-onnx-headers INTERFACE
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
  $<INSTALL_INTERFACE:include>
  $<INSTALL_INTERFACE:include/onnxruntime>)

if(QVAC_ONNX_ANDROID_LOG)
  target_compile_definitions(qvac-onnx-headers INTERFACE QVAC_ONNX_ENABLE_ANDROID_LOG)
endif()

# --- Installs ---
install(DIRECTORY src/qvac-onnx DESTINATION include FILES_MATCHING PATTERN "*.hpp")

install(DIRECTORY ${VCPKG_INSTALLED_PATH}/include/ DESTINATION include
  PATTERN "gtest" EXCLUDE PATTERN "gmock" EXCLUDE PATTERN "pybind11" EXCLUDE
  PATTERN "benchmark" EXCLUDE PATTERN "Eigen" EXCLUDE PATTERN "eigen3" EXCLUDE
  PATTERN "unsupported" EXCLUDE PATTERN "signature_of_eigen3_matrix_library" EXCLUDE
  PATTERN "absl" EXCLUDE PATTERN "google" EXCLUDE PATTERN "nlohmann" EXCLUDE
  PATTERN "boost" EXCLUDE PATTERN "flatbuffers" EXCLUDE PATTERN "onnx" EXCLUDE
  PATTERN "cxxopts.hpp" EXCLUDE PATTERN "utf8_range.h" EXCLUDE
  PATTERN "utf8_validity.h" EXCLUDE PATTERN "experiments-config.h" EXCLUDE)

# Mobile: also install static libs and cmake configs for static linking
if(ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS"))
  install(DIRECTORY ${VCPKG_INSTALLED_PATH}/lib/ DESTINATION lib
    FILES_MATCHING PATTERN "*.a" PATTERN "*.lib"
    PATTERN "pkgconfig" EXCLUDE PATTERN "libprotoc*" EXCLUDE PATTERN "libbenchmark*" EXCLUDE)

  install(CODE [=[
    if(NOT WIN32)
      find_program(_strip strip)
      if(_strip)
        file(GLOB _libs "${CMAKE_INSTALL_PREFIX}/lib/*.a")
        foreach(_lib IN LISTS _libs)
          if(APPLE)
            execute_process(COMMAND "${_strip}" -x "${_lib}" ERROR_QUIET)
          else()
            execute_process(COMMAND "${_strip}" --strip-unneeded "${_lib}" ERROR_QUIET)
          endif()
        endforeach()
      endif()
    endif()
  ]=])

  install(DIRECTORY ${VCPKG_INSTALLED_PATH}/share/ DESTINATION share
    PATTERN "gtest" EXCLUDE PATTERN "pybind11" EXCLUDE PATTERN "benchmark" EXCLUDE
    PATTERN "cxxopts" EXCLUDE PATTERN "qvac-lint-cpp" EXCLUDE PATTERN "pkgconfig" EXCLUDE
    PATTERN "vcpkg-cmake" EXCLUDE PATTERN "vcpkg-cmake-config" EXCLUDE
    PATTERN "vcpkg-boost" EXCLUDE PATTERN "vcpkg.spdx.json" EXCLUDE
    PATTERN "vcpkg_abi_info.txt" EXCLUDE PATTERN "copyright" EXCLUDE)

  # Patch shipped protobuf cmake configs
  install(CODE [=[
    set(_dir "${CMAKE_INSTALL_PREFIX}/share/protobuf")
    set(_f "${_dir}/protobuf-targets.cmake")
    if(EXISTS "${_f}")
      file(READ "${_f}" _c)
      string(REPLACE
        "# Create imported target protobuf::protoc\nadd_executable(protobuf::protoc IMPORTED)\n"
        "" _c "${_c}")
      string(REGEX REPLACE
        "# Create imported target protobuf::libprotoc\nadd_library\\(protobuf::libprotoc STATIC IMPORTED\\)\n\nset_target_properties\\(protobuf::libprotoc PROPERTIES\n[^)]*\\)\n"
        "" _c "${_c}")
      string(REPLACE " protobuf::protoc" "" _c "${_c}")
      string(REPLACE " protobuf::libprotoc" "" _c "${_c}")
      file(WRITE "${_f}" "${_c}")
    endif()
    set(_f "${_dir}/protobuf-targets-release.cmake")
    if(EXISTS "${_f}")
      file(READ "${_f}" _c)
      string(REGEX REPLACE
        "# Import target .protobuf::protoc. for configuration .[^.]*.\nset_property\\(TARGET protobuf::protoc[^\n]*\nset_target_properties\\(protobuf::protoc[^\n]*\n[^\n]*\n[^\n]*\n\nlist\\(APPEND _cmake_import_check_targets protobuf::protoc \\)\nlist\\(APPEND _cmake_import_check_files_for_protobuf::protoc[^\n]*\n"
        "" _c "${_c}")
      string(REGEX REPLACE
        "# Import target .protobuf::libprotoc. for configuration .[^.]*.\nset_property\\(TARGET protobuf::libprotoc[^\n]*\nset_target_properties\\(protobuf::libprotoc[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\nlist\\(APPEND _cmake_import_check_targets protobuf::libprotoc \\)\nlist\\(APPEND _cmake_import_check_files_for_protobuf::libprotoc[^\n]*\n"
        "" _c "${_c}")
      file(WRITE "${_f}" "${_c}")
    endif()
  ]=])

  # Patch shipped flatbuffers cmake configs
  install(CODE [=[
    set(_dir "${CMAKE_INSTALL_PREFIX}/share/flatbuffers")
    file(REMOVE "${_dir}/FlatcTargets.cmake" "${_dir}/FlatcTargets-release.cmake")
  ]=])

  # Patch shipped onnxruntime cmake configs
  install(CODE [=[
    set(_dir "${CMAKE_INSTALL_PREFIX}/share/onnxruntime")
    set(_f "${_dir}/onnxruntimeTargets.cmake")
    if(EXISTS "${_f}")
      file(READ "${_f}" _c)
      string(REGEX REPLACE
        "# Create imported target onnxruntime::onnxruntime\nadd_library\\(onnxruntime::onnxruntime SHARED IMPORTED\\)\n\nset_target_properties\\(onnxruntime::onnxruntime PROPERTIES\n[^)]*\\)\n"
        "" _c "${_c}")
      string(REPLACE " onnxruntime::onnxruntime " " " _c "${_c}")
      file(WRITE "${_f}" "${_c}")
    endif()
    set(_f "${_dir}/onnxruntimeTargets-release.cmake")
    if(EXISTS "${_f}")
      file(READ "${_f}" _c)
      string(REGEX REPLACE
        "# Import target .onnxruntime::onnxruntime. for configuration .[^.]*.\nset_property\\(TARGET onnxruntime::onnxruntime APPEND[^\n]*\nset_target_properties\\(onnxruntime::onnxruntime PROPERTIES\n[^)]*\\)\n\nlist\\(APPEND _cmake_import_check_targets onnxruntime::onnxruntime \\)\nlist\\(APPEND _cmake_import_check_files_for_onnxruntime::onnxruntime[^\n]*\n"
        "" _c "${_c}")
      file(WRITE "${_f}" "${_c}")
    endif()
  ]=])

  # Add missing find_dependency to shipped onnxruntimeConfig
  install(CODE [=[
    set(_f "${CMAKE_INSTALL_PREFIX}/share/onnxruntime/onnxruntimeConfig.cmake")
    if(EXISTS "${_f}")
      file(READ "${_f}" _c)
      string(REPLACE
        "include(\"\${CMAKE_CURRENT_LIST_DIR}/onnxruntimeTargets.cmake\")"
        "find_dependency(unofficial-pthreadpool CONFIG)\ninclude(\"\${CMAKE_CURRENT_LIST_DIR}/onnxruntimeTargets.cmake\")"
        _c "${_c}")
      file(WRITE "${_f}" "${_c}")
    endif()
  ]=])

  # Patch shipped Eigen3 cmake configs — remove non-existent include dir
  install(CODE [=[
    set(_f "${CMAKE_INSTALL_PREFIX}/share/eigen3/Eigen3Targets.cmake")
    if(EXISTS "${_f}")
      file(READ "${_f}" _c)
      string(REGEX REPLACE
        "set_target_properties\\(Eigen3::Eigen PROPERTIES\n  INTERFACE_INCLUDE_DIRECTORIES[^\n]*\n\\)\n"
        ""
        _c "${_c}")
      file(WRITE "${_f}" "${_c}")
    endif()
  ]=])

  # Strip LINK_ONLY from shipped cmake configs for cmake 4.x consumers
  install(CODE [=[
    foreach(_lo_file
        "${CMAKE_INSTALL_PREFIX}/share/onnxruntime/onnxruntimeTargets.cmake"
        "${CMAKE_INSTALL_PREFIX}/share/protobuf/protobuf-targets.cmake")
      if(EXISTS "${_lo_file}")
        file(READ "${_lo_file}" _c)
        string(CONCAT _lo_re "\\\\?" "\\$" [==[<LINK_ONLY:([^";]+)>]==])
        string(REGEX REPLACE "${_lo_re}" "\\1" _c "${_c}")
        file(WRITE "${_lo_file}" "${_c}")
      endif()
    endforeach()
  ]=])
endif()

# --- qvac-onnx cmake package config ---
install(TARGETS qvac-onnx-headers EXPORT qvac-onnxTargets)
install(EXPORT qvac-onnxTargets NAMESPACE qvac-onnx:: DESTINATION share/qvac-onnx/cmake)

include(CMakePackageConfigHelpers)
configure_package_config_file(
  cmake/qvac-onnxConfig.cmake.in
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-onnxConfig.cmake
  INSTALL_DESTINATION share/qvac-onnx/cmake)
write_basic_package_version_file(
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-onnxConfigVersion.cmake
  VERSION ${PROJECT_VERSION} COMPATIBILITY SameMajorVersion)
install(FILES
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-onnxConfig.cmake
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-onnxConfigVersion.cmake
  DESTINATION share/qvac-onnx/cmake)

# Android-specific
function(strip_libraries LIB_DIR LIB_NAMES)
  foreach(LIB_NAME IN LISTS LIB_NAMES)
    set(LIB_PATH "${LIB_DIR}/${LIB_NAME}")
    execute_process(COMMAND ${LLVM_STRIP} --strip-debug "${LIB_PATH}" ERROR_VARIABLE STRIP_ERROR)
    message("-- Stripping ${LIB_PATH} errorCode: ${STRIP_ERROR}")
  endforeach()
endfunction()

if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${qvac-onnx} PRIVATE ${Vulkan_LIBRARY} log)
  find_program(LLVM_STRIP llvm-strip)
  if(NOT LLVM_STRIP)
    message(WARNING "-- llvm-strip not found. Skipping library stripping for Android build.")
  else()
    set(LIBRARIES_TO_STRIP_IN_LIB_DIR libonnx.a libprotobuf.a)
    set(VCPKG_INSTALLED_DIR "${CMAKE_BINARY_DIR}/_vcpkg/${VCPKG_TARGET_TRIPLET}")
    strip_libraries("${VCPKG_INSTALLED_DIR}/lib" "${LIBRARIES_TO_STRIP_IN_LIB_DIR}")
  endif()
endif()

if(WIN32)
  target_compile_options(${qvac-onnx} PRIVATE "/utf-8")
  target_compile_definitions(${qvac-onnx} PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX NOGDI)
  target_link_libraries(${qvac-onnx} PRIVATE msvcrt.lib)
endif()

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()

  add_executable(unit_tests
    tests/tensor_types_test.cpp tests/config_test.cpp tests/interface_test.cpp)
  target_include_directories(unit_tests PRIVATE src)
  target_link_libraries(unit_tests PRIVATE GTest::gmock_main)
  gtest_discover_tests(unit_tests)

  add_executable(ort_tests
    tests/runtime_test.cpp tests/type_conversions_test.cpp
    tests/session_options_test.cpp tests/session_test.cpp
    tests/addon_shared_runtime_test.cpp)
  target_include_directories(ort_tests PRIVATE src)
  target_compile_definitions(ort_tests PRIVATE
    TEST_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
  target_link_libraries(ort_tests PRIVATE GTest::gmock_main onnxruntime::onnxruntime_static)
  gtest_discover_tests(ort_tests)
endif()
