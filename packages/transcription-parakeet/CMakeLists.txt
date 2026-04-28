cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage" OFF)
option(MOBILE_DYNAMIC_LINK "Use dynamic linking for ONNX Runtime on mobile" ON)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

project(qvac_lib_infer_parakeet
  VERSION 0.1.0
  LANGUAGES C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(
  QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
  REQUIRED
)

set(qvac-onnx_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/share/qvac-onnx/cmake")
find_package(qvac-onnx CONFIG REQUIRED)

find_package(Eigen3 CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI )
endif()

set(LIB_NAME parakeet_model_core)
set(LIB_SRCS_PATH ${PROJECT_SOURCE_DIR}/addon/src/model-interface)

set(LIB_SRCS
        ${LIB_SRCS_PATH}/ParakeetTypes.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetModel.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetModel.cpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetConfig.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetConfig.cpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetHandlers.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetHandlers.cpp
        ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.hpp
        ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
)

add_library(${LIB_NAME} STATIC ${LIB_SRCS})

target_include_directories(${LIB_NAME} PUBLIC
        ${PROJECT_SOURCE_DIR}/addon/src
        ${CMAKE_BINARY_DIR}
        ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
        ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

add_bare_module(qvac_lib_infer_parakeet EXPORTS)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${qvac_lib_infer_parakeet}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${qvac_lib_infer_parakeet}
  PRIVATE
    addon/src/js-interface/binding.cpp
)

target_include_directories(
  ${qvac_lib_infer_parakeet}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_compile_definitions(${qvac_lib_infer_parakeet} PUBLIC JS_LOGGER)

if((ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS")) AND NOT MOBILE_DYNAMIC_LINK)
  target_link_libraries(${LIB_NAME} PRIVATE qvac-onnx::qvac-onnx-static nlohmann_json::nlohmann_json Eigen3::Eigen)

  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      ${LIB_NAME}
      qvac-onnx::qvac-onnx-static
  )
else()
  target_link_libraries(${LIB_NAME} PRIVATE qvac-onnx::headers nlohmann_json::nlohmann_json Eigen3::Eigen)

  include_bare_module("@qvac/onnx" qvac_onnx_target PREBUILD)

  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      ${LIB_NAME}
      qvac-onnx::headers
  )
  target_link_libraries(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      ${qvac_onnx_target}_module
  )

  bare_target(host)
  bare_module_target("." _unused NAME addon_name)
  install(FILES $<TARGET_FILE:${qvac_onnx_target}_module>
    DESTINATION ${host}/${addon_name}
    RENAME qvac__onnx@0.bare)
endif()

if(WIN32)
  target_compile_options(${qvac_lib_infer_parakeet} PRIVATE "/utf-8")

  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      msvcrt.lib
  )
endif()

if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${qvac_lib_infer_parakeet} PRIVATE ${Vulkan_LIBRARY})

  find_program(LLVM_STRIP llvm-strip)

  if(NOT LLVM_STRIP)
    message(WARNING "-- llvm-strip not found. Skipping library stripping for Android build.")
  else()
    message("-- llvm-strip found: ${LLVM_STRIP}")
    set(LIBRARIES_TO_STRIP libonnx.a libprotobuf.a libprotoc.a libflatbuffers.a libprotobuf-lite.a libre2.a)

    set(VCPKG_INSTALLED_DIR "${CMAKE_BINARY_DIR}/_vcpkg/${VCPKG_TARGET_TRIPLET}")
    set(LIBS_DIR_PATH "${VCPKG_INSTALLED_DIR}/lib")

    foreach(LIB ${LIBRARIES_TO_STRIP})
      set(LIB_PATH "${LIBS_DIR_PATH}/${LIB}")
      if(EXISTS "${LIB_PATH}")
        execute_process(COMMAND ${LLVM_STRIP} --strip-debug "${LIB_PATH}")
        message("-- Stripped: ${LIB}")
      endif()
    endforeach()
  endif()
endif()

if(APPLE)
  set_target_properties(
    ${qvac_lib_infer_parakeet}
    PROPERTIES
      BUILD_RPATH "@loader_path"
      INSTALL_RPATH "@loader_path"
      MACOSX_RPATH ON
  )
  target_link_options(
    ${qvac_lib_infer_parakeet}
    PRIVATE "-Wl,-rpath,@loader_path"
  )
endif()

if(UNIX AND NOT APPLE)
  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map
  )
elseif(APPLE)
  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()

bare_platform(PREBUILD_PLATFORM)
bare_arch(PREBUILD_ARCH)
set(PREBUILD_DIR "${CMAKE_SOURCE_DIR}/prebuilds/${PREBUILD_PLATFORM}-${PREBUILD_ARCH}")

if(ANDROID)
  if(CMAKE_STRIP)
    set(ANDROID_STRIP_TOOL "${CMAKE_STRIP}")
  else()
    set(ANDROID_STRIP_TOOL "$ENV{ANDROID_NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip")
  endif()

  install(CODE "
    set(STRIP_TOOL \"${ANDROID_STRIP_TOOL}\")
    set(BINARY_PATH \"${PREBUILD_DIR}/qvac__transcription-parakeet.bare\")
    if(EXISTS \"\${STRIP_TOOL}\")
      execute_process(COMMAND \"\${STRIP_TOOL}\" --strip-debug \"\${BINARY_PATH}\" RESULT_VARIABLE STRIP_RESULT)
      if(STRIP_RESULT EQUAL 0)
        message(STATUS \"Stripped debug symbols from Android binary\")
      else()
        message(WARNING \"Failed to strip Android binary\")
      endif()
    else()
      message(WARNING \"Strip tool not found at: \${STRIP_TOOL}\")
    endif()
  ")
endif()

if(BUILD_TESTING)
    enable_testing()
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)

    add_executable(
        parakeet_tests
        addon/tests/test_core.cpp
        addon/tests/AddonCppTest.cpp
        addon/src/model-interface/parakeet/ParakeetModel.cpp
        addon/src/model-interface/parakeet/ParakeetConfig.cpp
    )

    target_include_directories(parakeet_tests
      PRIVATE
        addon/src
        ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    )

    if(TARGET qvac-onnx::qvac-onnx-static)
      set(QVAC_TEST_ORT_TARGET qvac-onnx::qvac-onnx-static)
    elseif(DEFINED qvac_onnx_target)
      set(QVAC_TEST_ORT_TARGET ${qvac_onnx_target}_module)
    else()
      set(QVAC_TEST_ORT_TARGET qvac-onnx::headers)
    endif()

    target_link_libraries(parakeet_tests
      PRIVATE
        GTest::gmock_main
        qvac-onnx::headers
        ${QVAC_TEST_ORT_TARGET}
        nlohmann_json::nlohmann_json
        Eigen3::Eigen
    )

    if(ENABLE_COVERAGE)
        target_compile_options(parakeet_tests PRIVATE
            -fprofile-instr-generate
            -fcoverage-mapping
        )
        target_compile_options(parakeet_model_core PRIVATE
            -fprofile-instr-generate
            -fcoverage-mapping
        )
        target_link_options(parakeet_tests PRIVATE
            -fprofile-instr-generate
        )
        message(STATUS "LLVM Coverage enabled for parakeet tests")
    endif()
    set(_onnx_prebuilds "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/${PREBUILD_PLATFORM}-${PREBUILD_ARCH}")
    if(EXISTS "${_onnx_prebuilds}/qvac__onnx.bare" AND NOT EXISTS "${_onnx_prebuilds}/qvac__onnx@0.bare")
      file(CREATE_LINK "${_onnx_prebuilds}/qvac__onnx.bare" "${_onnx_prebuilds}/qvac__onnx@0.bare" COPY_ON_ERROR)
    endif()
    # CI invokes the test binary directly via npm scripts, so avoid running it
    # during build-time discovery where libc++/coverage combinations have been
    # aborting before the actual test step starts.
    add_test(NAME parakeet_tests COMMAND parakeet_tests)
endif()
