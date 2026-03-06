cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
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
  add_link_options(-stdlib=libc++)
endif()

# Find dependencies
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/Addon.hpp" REQUIRED)

# Find ONNX Runtime
find_package(onnxruntime CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI )
endif()

# Build parakeet core lib
set(LIB_NAME parakeet_model_core)
set(LIB_SRCS_PATH ${PROJECT_SOURCE_DIR}/addon/src/model-interface)

set(LIB_SRCS
        ${LIB_SRCS_PATH}/ParakeetTypes.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetModel.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetModel.cpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetConfig.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetConfig.cpp
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

# Use static linking for mobile platforms (ONNX runtime must be bundled in the binary)
if(ANDROID OR IOS)
  target_link_libraries(${LIB_NAME} PRIVATE onnxruntime::onnxruntime_static)
else()
  target_link_libraries(${LIB_NAME} PRIVATE onnxruntime::onnxruntime)
endif()

# Create the Bare addon module using bare-make's helper
add_bare_module(qvac_lib_infer_parakeet EXPORTS)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${qvac_lib_infer_parakeet}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${qvac_lib_infer_parakeet}
  PRIVATE
    addon/src/js-interface/binding.cpp
    addon/src/js-interface/qvac-lib-infer-parakeet.cpp
    addon/src/addon/Addon.cpp
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

# Use static linking for mobile platforms
if(ANDROID OR IOS)
  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      ${LIB_NAME}
      onnxruntime::onnxruntime_static
  )
else()
  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      ${LIB_NAME}
      onnxruntime::onnxruntime
  )
endif()

# Platform-specific settings
if(WIN32)
  target_compile_options(${qvac_lib_infer_parakeet} PRIVATE "/utf-8")
  
  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      msvcrt.lib
  )
endif()

# Android-specific settings
if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${qvac_lib_infer_parakeet} PRIVATE ${Vulkan_LIBRARY})
  
  # Strip vcpkg installed binaries for Android builds to reduce size
  find_program(LLVM_STRIP llvm-strip)

  if(NOT LLVM_STRIP)
    message(WARNING "-- llvm-strip not found. Skipping library stripping for Android build.")
  else()
    message("-- llvm-strip found: ${LLVM_STRIP}")
    set(LIBRARIES_TO_STRIP libonnx.a libprotobuf.a libprotoc.a libflatbuffers.a libprotobuf-lite.a libre2.a)

    set(VCPKG_INSTALLED_DIR "${CMAKE_BINARY_DIR}/_vcpkg/${VCPKG_TARGET_TRIPLET}")
    set(LIBS_DIR_PATH "${VCPKG_INSTALLED_DIR}/lib")

    # Strip each library if it exists
    foreach(LIB ${LIBRARIES_TO_STRIP})
      set(LIB_PATH "${LIBS_DIR_PATH}/${LIB}")
      if(EXISTS "${LIB_PATH}")
        execute_process(COMMAND ${LLVM_STRIP} --strip-debug "${LIB_PATH}")
        message("-- Stripped: ${LIB}")
      endif()
    endforeach()
  endif()
endif()

# Note: We target the _module shared library, not the object library
if(UNIX AND NOT APPLE)
  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map
  )
elseif(APPLE)
  # macOS uses -exported_symbols_list instead of version script
  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()

# Note: RPATH is fixed post-install below since cmake-bare overrides target properties

# Compute prebuild architecture directory (matches bare-make conventions)
bare_platform(PREBUILD_PLATFORM)
bare_arch(PREBUILD_ARCH)
set(PREBUILD_DIR "${CMAKE_SOURCE_DIR}/prebuilds/${PREBUILD_PLATFORM}-${PREBUILD_ARCH}")

# Install ONNX Runtime shared libraries alongside the addon
get_target_property(ORT_LIB_LOCATION onnxruntime::onnxruntime IMPORTED_LOCATION_RELEASE)
if(NOT ORT_LIB_LOCATION)
  get_target_property(ORT_LIB_LOCATION onnxruntime::onnxruntime IMPORTED_LOCATION)
endif()
if(ORT_LIB_LOCATION)
  get_filename_component(ORT_LIB_DIR "${ORT_LIB_LOCATION}" DIRECTORY)
  
  if(UNIX AND NOT APPLE)
    # Linux: Install main shared library with symlinks
    install(FILES
      "${ORT_LIB_DIR}/libonnxruntime.so.1.21.0"
      DESTINATION "${PREBUILD_DIR}"
      OPTIONAL
    )
    install(CODE "
      execute_process(COMMAND ${CMAKE_COMMAND} -E create_symlink libonnxruntime.so.1.21.0 ${PREBUILD_DIR}/libonnxruntime.so.1)
      execute_process(COMMAND ${CMAKE_COMMAND} -E create_symlink libonnxruntime.so.1 ${PREBUILD_DIR}/libonnxruntime.so)
    ")
    # Install providers shared library
    install(FILES
      "${ORT_LIB_DIR}/libonnxruntime_providers_shared.so"
      DESTINATION "${PREBUILD_DIR}"
      OPTIONAL
    )
    # Bundle libc++ runtime libs required by onnxruntime's shared library
    install(CODE "
      foreach(_lib libc++.so.1 libc++abi.so.1 libunwind.so.1)
        execute_process(
          COMMAND ${CMAKE_CXX_COMPILER} -stdlib=libc++ -print-file-name=\${_lib}
          OUTPUT_VARIABLE _lib_path OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        if(EXISTS \"\${_lib_path}\")
          get_filename_component(_real_path \"\${_lib_path}\" REALPATH)
          file(INSTALL \"\${_real_path}\" DESTINATION \"${PREBUILD_DIR}\")
          get_filename_component(_real_name \"\${_real_path}\" NAME)
          if(NOT _real_name STREQUAL \"\${_lib}\")
            file(CREATE_LINK \"\${_real_name}\" \"${PREBUILD_DIR}/\${_lib}\" SYMBOLIC)
          endif()
          message(STATUS \"Bundled \${_lib} -> \${_real_path}\")
        endif()
      endforeach()
    ")
  elseif(APPLE)
    # macOS: Install dylib files
    file(GLOB ORT_DYLIBS "${ORT_LIB_DIR}/libonnxruntime*.dylib")
    install(FILES ${ORT_DYLIBS}
      DESTINATION "${PREBUILD_DIR}"
      OPTIONAL
    )
  elseif(WIN32)
    # Windows: Install DLL files
    # DLLs are usually in bin/ directory, not lib/
    get_filename_component(ORT_ROOT_DIR "${ORT_LIB_DIR}" DIRECTORY)
    file(GLOB ORT_DLLS "${ORT_ROOT_DIR}/bin/onnxruntime*.dll")
    if(NOT ORT_DLLS)
      file(GLOB ORT_DLLS "${ORT_LIB_DIR}/onnxruntime*.dll")
    endif()
    install(FILES ${ORT_DLLS}
      DESTINATION "${PREBUILD_DIR}"
      OPTIONAL
    )
  endif()
endif()

# Fix RPATH after install (cmake-bare sets a different RPATH that we need to override)
if(UNIX AND NOT APPLE AND NOT ANDROID)
  find_program(PATCHELF patchelf)
  if(PATCHELF)
    install(CODE "
      execute_process(COMMAND ${PATCHELF} --set-rpath \"\$ORIGIN\" \"${PREBUILD_DIR}/qvac__transcription-parakeet.bare\")
    ")
  endif()
elseif(APPLE)
  # macOS: Add @loader_path to RPATH so the addon can find dylibs in the same directory
  install(CODE "
    execute_process(COMMAND install_name_tool -add_rpath @loader_path \"${PREBUILD_DIR}/qvac__transcription-parakeet.bare\")
  ")
elseif(ANDROID)
  # Android: Strip debug symbols from the final binary using NDK's llvm-strip
  # CMAKE_STRIP is set by the Android toolchain, or we find it in NDK
  if(CMAKE_STRIP)
    set(ANDROID_STRIP_TOOL "${CMAKE_STRIP}")
  else()
    # Fallback: construct path from ANDROID_NDK
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

# Build tests if enabled
if(BUILD_TESTING)
    enable_testing()
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)

    add_executable(
        parakeet_tests
        addon/tests/test_core.cpp
        addon/src/model-interface/parakeet/ParakeetModel.cpp
        addon/src/model-interface/parakeet/ParakeetConfig.cpp
    )
    
    target_include_directories(parakeet_tests 
      PRIVATE 
        addon/src
        ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    )
    
    target_link_libraries(parakeet_tests 
      PRIVATE 
        GTest::gmock_main
        onnxruntime::onnxruntime
    )
    
    # Coverage configuration
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
    
    gtest_discover_tests(parakeet_tests)
endif()
