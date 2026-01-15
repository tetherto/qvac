cmake_minimum_required(VERSION 3.25)

# Include config file to override options (must be before option() calls)
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
  include(${CMAKE_CURRENT_SOURCE_DIR}/config.cmake)
endif()

option(BUILD_TESTING "Build tests" OFF)
option(USE_BERGAMOT "Enable Bergamot backend support" ON)

if(USE_BERGAMOT)
  set(BERGAMOT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third-party/bergamot-translator")
  if(NOT EXISTS "${BERGAMOT_DIR}/CMakeLists.txt")
    message(WARNING "Bergamot backend requested but submodule missing at ${BERGAMOT_DIR}. Disabling USE_BERGAMOT.")
    set(USE_BERGAMOT OFF)
  endif()
endif()

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

# Android STL configuration must be set before project()
if(DEFINED ENV{ANDROID_NDK} OR DEFINED ENV{ANDROID_NDK_HOME})
  set(ANDROID_STL c++_shared)
endif()

project(qvac-lib-infer-nmtcpp
  VERSION 2.0.0
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

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

message(STATUS ${CMAKE_CXX_COMPILER_ID})
if(WIN32)
  add_definitions( -DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI )
endif()

# Required by Tokenizers
if(ANDROID)
  set(ANDROID_TOOLCHAIN_ROOT "$ENV{ANDROID_TOOLCHAIN_ROOT}")
  set(ANDROID_NATIVE_API_LEVEL "$ENV{ANDROID_NATIVE_API_LEVEL}")
endif()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/Addon.hpp")

find_package(ggml CONFIG REQUIRED)
find_package(absl CONFIG QUIET)
find_package(protobuf CONFIG REQUIRED)

if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
  find_package(Iconv REQUIRED)
endif()

find_package(PkgConfig QUIET)

find_package(sentencepiece CONFIG QUIET)
if(sentencepiece_FOUND)
  set(SENTENCEPIECE_TARGET sentencepiece::sentencepiece)
elseif(NOT WIN32)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(sentencepiece REQUIRED IMPORTED_TARGET sentencepiece)
  set(SENTENCEPIECE_TARGET PkgConfig::sentencepiece)
else()
  find_path(SENTENCEPIECE_INCLUDE_DIR
    NAMES sentencepiece_processor.h
    PATHS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES include
  )

  find_library(SENTENCEPIECE_LIBRARY
    NAMES sentencepiece
    PATHS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
  )

  if(SENTENCEPIECE_INCLUDE_DIR AND SENTENCEPIECE_LIBRARY)
    add_library(sentencepiece::sentencepiece UNKNOWN IMPORTED)
    set_target_properties(sentencepiece::sentencepiece PROPERTIES
      IMPORTED_LOCATION "${SENTENCEPIECE_LIBRARY}"
      INTERFACE_INCLUDE_DIRECTORIES "${SENTENCEPIECE_INCLUDE_DIR}"
    )
    set(SENTENCEPIECE_TARGET sentencepiece::sentencepiece)
    set(SENTENCEPIECE_INCLUDE_DIRS "${SENTENCEPIECE_INCLUDE_DIR}")
  else()
    if(PkgConfig_FOUND)
      pkg_check_modules(sentencepiece QUIET IMPORTED_TARGET sentencepiece)
      if(sentencepiece_FOUND)
        set(SENTENCEPIECE_TARGET PkgConfig::sentencepiece)
      else()
        message(FATAL_ERROR "sentencepiece not found. Please install it via vcpkg.")
      endif()
    else()
      message(FATAL_ERROR "sentencepiece not found. Please install it via vcpkg.")
    endif()
  endif()
endif()

# Configure and add bergamot-translator if enabled
if(USE_BERGAMOT)
  message(STATUS "Bergamot backend enabled")

  # Use C++17 for Bergamot to avoid std::result_of removal in C++20
  # Bergamot's dependencies (CLI11, threadpool) use std::result_of which was removed in C++20
  # This must be set as a cache variable BEFORE add_subdirectory() to propagate
  set(CMAKE_CXX_STANDARD 17 CACHE STRING "C++ standard version" FORCE)

  # Android has pthreads built into Bionic libc, so no separate pthread library needed
  if(ANDROID)
    set(CMAKE_THREAD_LIBS_INIT "")
    set(CMAKE_HAVE_THREADS_LIBRARY 1)
    set(CMAKE_USE_WIN32_THREADS_INIT 0)
    set(CMAKE_USE_PTHREADS_INIT 1)
    set(THREADS_PREFER_PTHREAD_FLAG ON)
    # Force find_package(Threads) to succeed for Android
    set(CMAKE_THREAD_PREFER_PTHREAD TRUE)
    find_package(Threads REQUIRED)
  endif()

  # Set BUILD_ARCH to a portable value instead of "native" to ensure compatibility
  # across different CI runners. x86-64-v2 provides SSE4.2 which is widely supported.
  # Using "native" can cause crashes if the build machine has AVX512 but runtime doesn't.
  # Only apply this to x86/x64 platforms, not ARM64.
  if(NOT ANDROID AND NOT APPLE AND NOT CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|ARM64")
    set(BUILD_ARCH "x86-64-v2" CACHE STRING "Compile for this CPU architecture" FORCE)
    message(STATUS "Setting BUILD_ARCH to x86-64-v2 for portability")
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|ARM64")
    set(BUILD_ARCH "armv8-a" CACHE STRING "Compile for ARM64 architecture" FORCE)
    message(STATUS "Setting BUILD_ARCH to armv8-a for ARM64")
  endif()

  # Configure bergamot-translator as a static library
  set(COMPILE_CUDA OFF CACHE BOOL "Compile GPU version" FORCE)
  set(COMPILE_WASM OFF CACHE BOOL "Compile WASM version" FORCE)
  set(USE_SENTENCEPIECE ON CACHE BOOL "Download and compile SentencePiece" FORCE)
  set(USE_STATIC_LIBS ON CACHE BOOL "Link statically against non-system libs" FORCE)
  set(SSPLIT_COMPILE_LIBRARY_ONLY ON CACHE BOOL "Do not compile ssplit tests" FORCE)
  set(SSPLIT_USE_INTERNAL_PCRE2 ON CACHE BOOL "Use internal PCRE2 instead of system's" FORCE)
  set(COMPILE_LIBRARY_ONLY ON CACHE BOOL "Build only the Marian library and exclude all executables." FORCE)
  set(USE_MKL OFF CACHE BOOL "Compile with MKL support" FORCE)
  # Only enable intgemm for non-Android platforms (x86/x64 only)
  # intgemm uses x86-specific SIMD instructions which don't compile on ARM
  message(STATUS "ANDROID variable is: ${ANDROID}")
  if(NOT ANDROID)
    message(STATUS "Enabling USE_INTGEMM for non-Android platform")
    set(USE_INTGEMM ON CACHE BOOL "Use INTGEMM for int8 quantized models" FORCE)
  else()
    message(STATUS "Skipping USE_INTGEMM for Android platform")
  endif()
  message(STATUS "USE_INTGEMM is now: ${USE_INTGEMM}")
  set(COMPILE_TESTS OFF CACHE BOOL "Compile bergamot-tests" FORCE)
  set(COMPILE_UNIT_TESTS OFF CACHE BOOL "Compile unit tests" FORCE)
  set(GIT_SUBMODULE ON CACHE BOOL "Check submodules during build" FORCE)

  # Use vcpkg's external protobuf instead of sentencepiece's builtin protobuf
  set(SPM_PROTOBUF_PROVIDER "package" CACHE STRING "Provider of protobuf library" FORCE)

  # Don't use -march=native for Android cross-compilation
  if(ANDROID)
    set(BUILD_ARCH "armv8-a" CACHE STRING "Compile for ARMv8-A architecture" FORCE)
    # Disable cpuinfo tests and benchmarks which require Threads
    set(CPUINFO_BUILD_UNIT_TESTS OFF CACHE BOOL "Build cpuinfo unit tests" FORCE)
    set(CPUINFO_BUILD_MOCK_TESTS OFF CACHE BOOL "Build cpuinfo mock tests" FORCE)
    set(CPUINFO_BUILD_BENCHMARKS OFF CACHE BOOL "Build cpuinfo benchmarks" FORCE)
  endif()

  # Apply patches to fix compilation issues in bergamot-translator
  set(BERGAMOT_PATCH_DIR "${CMAKE_CURRENT_SOURCE_DIR}/patches")
  set(BERGAMOT_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third-party/bergamot-translator")

  # Apply VLA fixes patch
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-vla-errors.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
    RESULT_VARIABLE PATCH_CHECK_RESULT
    OUTPUT_QUIET
    ERROR_QUIET
  )

  if(PATCH_CHECK_RESULT EQUAL 0)
    message(STATUS "Applying VLA fixes patch to bergamot-translator")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-vla-errors.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
      RESULT_VARIABLE PATCH_RESULT
    )
    if(NOT PATCH_RESULT EQUAL 0)
      message(FATAL_ERROR "Failed to apply VLA fixes patch")
    endif()
  else()
    message(STATUS "VLA fixes patch already applied or not needed")
  endif()

  # Apply zlib patch
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-zlib.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
    RESULT_VARIABLE PATCH_CHECK_RESULT
    OUTPUT_QUIET
    ERROR_QUIET
  )
  
  if(PATCH_CHECK_RESULT EQUAL 0)
    message(STATUS "Applying zlib fixes patch to bergamot-translator")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-zlib.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
      RESULT_VARIABLE PATCH_RESULT
    )
    if(NOT PATCH_RESULT EQUAL 0)
       message(FATAL_ERROR "Failed to apply zlib patches")
    endif()
  else()
    message(STATUS "Zlib fixes patch already applied or not needed")
  endif()

  # Apply sentencepiece external protobuf patch
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-sentencepiece-external-protobuf.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/sentencepiece"
    RESULT_VARIABLE SPM_PATCH_CHECK_RESULT
    OUTPUT_QUIET
    ERROR_QUIET
  )

  if(SPM_PATCH_CHECK_RESULT EQUAL 0)
    message(STATUS "Applying sentencepiece external protobuf patch")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-sentencepiece-external-protobuf.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/sentencepiece"
      RESULT_VARIABLE SPM_PATCH_RESULT
    )
    if(NOT SPM_PATCH_RESULT EQUAL 0)
      message(FATAL_ERROR "Failed to apply sentencepiece external protobuf patch")
    endif()
  else()
    message(STATUS "Sentencepiece external protobuf patch already applied or not needed")
  endif()

  # Apply sentencepiece cmake version fix
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-sentencepiece-cmake-version.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/sentencepiece"
    RESULT_VARIABLE SPM_CMAKE_VERSION_CHECK
    OUTPUT_QUIET
    ERROR_QUIET
  )
  if(SPM_CMAKE_VERSION_CHECK EQUAL 0)
    message(STATUS "Applying sentencepiece cmake version patch")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-sentencepiece-cmake-version.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/sentencepiece"
      RESULT_VARIABLE SPM_CMAKE_VERSION_RESULT
    )
    if(NOT SPM_CMAKE_VERSION_RESULT EQUAL 0)
      message(FATAL_ERROR "Failed to apply sentencepiece cmake version patch")
    endif()
  else()
    message(STATUS "Sentencepiece cmake version patch already applied or not needed")
  endif()

  # Apply clog cmake version fix (cpuinfo dependency)
  set(CLOG_DIR "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/ruy/third_party/cpuinfo/deps/clog")
  message(STATUS "Checking for clog at: ${CLOG_DIR}/CMakeLists.txt")
  if(EXISTS "${CLOG_DIR}/CMakeLists.txt")
    message(STATUS "Found clog directory, attempting to apply patch")
    execute_process(
      COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-clog-cmake-version.patch"
      WORKING_DIRECTORY "${CLOG_DIR}"
      RESULT_VARIABLE CLOG_CMAKE_VERSION_CHECK
      OUTPUT_QUIET
      ERROR_QUIET
    )
    if(CLOG_CMAKE_VERSION_CHECK EQUAL 0)
      message(STATUS "Applying clog cmake version patch")
      execute_process(
        COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-clog-cmake-version.patch"
        WORKING_DIRECTORY "${CLOG_DIR}"
        RESULT_VARIABLE CLOG_CMAKE_VERSION_RESULT
      )
      if(NOT CLOG_CMAKE_VERSION_RESULT EQUAL 0)
        message(FATAL_ERROR "Failed to apply clog cmake version patch")
      endif()
    else()
      message(STATUS "Clog cmake version patch already applied or not needed")
    endif()
  else()
    message(STATUS "Clog directory not found - skipping patch (will be downloaded later)")
  endif()

  # Apply PCRE2 cmake version fix if source already exists (from previous download)
  # This handles the case where PCRE2 was downloaded in a previous build
  set(PCRE2_SOURCE_DIR "${BERGAMOT_SRC_DIR}/3rd_party/ssplit-cpp/src/3rd-party/pcre2-10.39")
  if(EXISTS "${PCRE2_SOURCE_DIR}/CMakeLists.txt")
    execute_process(
      COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-pcre2-cmake-version.patch"
      WORKING_DIRECTORY "${PCRE2_SOURCE_DIR}"
      RESULT_VARIABLE PCRE2_EXISTING_CHECK
      OUTPUT_QUIET
      ERROR_QUIET
    )
    if(PCRE2_EXISTING_CHECK EQUAL 0)
      message(STATUS "Applying PCRE2 cmake version patch to existing source")
      execute_process(
        COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-pcre2-cmake-version.patch"
        WORKING_DIRECTORY "${PCRE2_SOURCE_DIR}"
        RESULT_VARIABLE PCRE2_EXISTING_RESULT
      )
      if(NOT PCRE2_EXISTING_RESULT EQUAL 0)
        message(FATAL_ERROR "Failed to apply PCRE2 cmake version patch to existing source")
      endif()
    else()
      message(STATUS "PCRE2 cmake version patch already applied to existing source or not needed")
    endif()
  endif()

  # Copy our custom FindPCRE2.cmake to ssplit-cpp's cmake directory
  # ssplit-cpp replaces CMAKE_MODULE_PATH, so we must put our file in its cmake dir
  set(SSPLIT_CMAKE_DIR "${BERGAMOT_SRC_DIR}/3rd_party/ssplit-cpp/cmake")
  configure_file(
    "${BERGAMOT_PATCH_DIR}/FindPCRE2.cmake"
    "${SSPLIT_CMAKE_DIR}/FindPCRE2.cmake"
    COPYONLY
  )
  message(STATUS "Copied custom FindPCRE2.cmake to ssplit-cpp cmake directory")

  # Set PCRE2 patch script to be used by our custom FindPCRE2.cmake
  # The patch must run during build phase (after PCRE2 download) not configure phase
  set(PCRE2_PATCH_SCRIPT "${BERGAMOT_PATCH_DIR}/apply-pcre2-cmake-fix.cmake" CACHE FILEPATH "Script to patch PCRE2 CMakeLists.txt" FORCE)
  message(STATUS "PCRE2 patch script configured: ${PCRE2_PATCH_SCRIPT}")

  # Apply intgemm clang-cl compiler flags fix for Windows
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-intgemm-clang-cl-flags.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/intgemm"
    RESULT_VARIABLE INTGEMM_CLANG_CL_CHECK
    OUTPUT_QUIET
    ERROR_QUIET
  )
  if(INTGEMM_CLANG_CL_CHECK EQUAL 0)
    message(STATUS "Applying intgemm clang-cl flags patch")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-intgemm-clang-cl-flags.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/intgemm"
      RESULT_VARIABLE INTGEMM_CLANG_CL_RESULT
    )
    if(NOT INTGEMM_CLANG_CL_RESULT EQUAL 0)
      message(FATAL_ERROR "Failed to apply intgemm clang-cl flags patch")
    endif()
  else()
    message(STATUS "Intgemm clang-cl flags patch already applied or not needed")
  endif()

  # Apply Marian clang-cl /arch:SSE2 fix for Windows
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-marian-clang-cl-sse2-arch.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
    RESULT_VARIABLE MARIAN_CLANG_CL_SSE2_CHECK
    OUTPUT_QUIET
    ERROR_QUIET
  )
  if(MARIAN_CLANG_CL_SSE2_CHECK EQUAL 0)
    message(STATUS "Applying Marian clang-cl SSE2 arch patch")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-marian-clang-cl-sse2-arch.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
      RESULT_VARIABLE MARIAN_CLANG_CL_SSE2_RESULT
    )
    if(NOT MARIAN_CLANG_CL_SSE2_RESULT EQUAL 0)
      message(FATAL_ERROR "Failed to apply Marian clang-cl SSE2 arch patch")
    endif()
  else()
    message(STATUS "Marian clang-cl SSE2 arch patch already applied or not needed")
  endif()

  # Apply C++17 std::result_of to std::invoke_result patch
  execute_process(
    COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-cpp17-result-of.patch"
    WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}"
    RESULT_VARIABLE CPP17_PATCH_CHECK_RESULT
    OUTPUT_QUIET
    ERROR_QUIET
  )

  if(CPP17_PATCH_CHECK_RESULT EQUAL 0)
    message(STATUS "Applying C++17 result_of patch to bergamot-translator")
    execute_process(
      COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-cpp17-result-of.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}"
      RESULT_VARIABLE CPP17_PATCH_RESULT
    )
    if(NOT CPP17_PATCH_RESULT EQUAL 0)
      message(FATAL_ERROR "Failed to apply C++17 result_of patch")
    endif()
  else()
    message(STATUS "C++17 result_of patch already applied or not needed")
  endif()

  # Apply Android-specific patches
  if(ANDROID)
    # Apply std::result_of fix for Android (different from C++17 patch above)
    execute_process(
      COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-android-std-result-of.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
      RESULT_VARIABLE ANDROID_RESULT_OF_CHECK
      OUTPUT_QUIET
      ERROR_QUIET
    )
    if(ANDROID_RESULT_OF_CHECK EQUAL 0)
      message(STATUS "Applying Android std::result_of patch")
      execute_process(
        COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-android-std-result-of.patch"
        WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev"
        RESULT_VARIABLE ANDROID_RESULT_OF_RESULT
      )
      if(NOT ANDROID_RESULT_OF_RESULT EQUAL 0)
        message(FATAL_ERROR "Failed to apply Android std::result_of patch")
      endif()
    else()
      message(STATUS "Android std::result_of patch already applied or not needed")
    endif()

    # Apply cpuinfo pthread fix for Android
    execute_process(
      COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-android-cpuinfo-threads.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/ruy/third_party/cpuinfo"
      RESULT_VARIABLE ANDROID_CPUINFO_CHECK
      OUTPUT_QUIET
      ERROR_QUIET
    )
    if(ANDROID_CPUINFO_CHECK EQUAL 0)
      message(STATUS "Applying Android cpuinfo pthread patch")
      execute_process(
        COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-android-cpuinfo-threads.patch"
        WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/ruy/third_party/cpuinfo"
        RESULT_VARIABLE ANDROID_CPUINFO_RESULT
      )
      if(NOT ANDROID_CPUINFO_RESULT EQUAL 0)
        message(FATAL_ERROR "Failed to apply Android cpuinfo pthread patch")
      endif()
    else()
      message(STATUS "Android cpuinfo pthread patch already applied or not needed")
    endif()

    # Apply sentencepiece pthread fix for Android
    execute_process(
      COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-android-sentencepiece-threads.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/sentencepiece"
      RESULT_VARIABLE ANDROID_SPM_CHECK
      OUTPUT_QUIET
      ERROR_QUIET
    )
    if(ANDROID_SPM_CHECK EQUAL 0)
      message(STATUS "Applying Android sentencepiece pthread patch")
      execute_process(
        COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-android-sentencepiece-threads.patch"
        WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/marian-dev/src/3rd_party/sentencepiece"
        RESULT_VARIABLE ANDROID_SPM_RESULT
      )
      if(NOT ANDROID_SPM_RESULT EQUAL 0)
        message(FATAL_ERROR "Failed to apply Android sentencepiece pthread patch")
      endif()
    else()
      message(STATUS "Android sentencepiece pthread patch already applied or not needed")
    endif()

    # Apply PCRE2 cross-compilation fix for Android
    execute_process(
      COMMAND git apply --check "${BERGAMOT_PATCH_DIR}/fix-android-pcre2-cross-compile.patch"
      WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/ssplit-cpp"
      RESULT_VARIABLE ANDROID_PCRE2_CHECK
      OUTPUT_QUIET
      ERROR_QUIET
    )
    if(ANDROID_PCRE2_CHECK EQUAL 0)
      message(STATUS "Applying Android PCRE2 cross-compilation patch")
      execute_process(
        COMMAND git apply "${BERGAMOT_PATCH_DIR}/fix-android-pcre2-cross-compile.patch"
        WORKING_DIRECTORY "${BERGAMOT_SRC_DIR}/3rd_party/ssplit-cpp"
        RESULT_VARIABLE ANDROID_PCRE2_RESULT
      )
      if(NOT ANDROID_PCRE2_RESULT EQUAL 0)
        message(FATAL_ERROR "Failed to apply Android PCRE2 cross-compilation patch")
      endif()
    else()
      message(STATUS "Android PCRE2 cross-compilation patch already applied or not needed")
    endif()
  endif()

  # Temporarily allow VLA extension for Marian NMT code
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wno-vla-cxx-extension" CACHE STRING "C++ compiler flags" FORCE)

  # Add bergamot-translator
  add_subdirectory(third-party/bergamot-translator EXCLUDE_FROM_ALL)

  # Restore CMAKE_CXX_FLAGS to not be cached
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}" CACHE STRING "C++ compiler flags" FORCE)
endif()

add_bare_module(qvac-lib-infer-nmtcpp EXPORTS)

target_sources(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/addon/Addon.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/qvac-lib-infer-nmtcpp.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TranslationModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_tokenization.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_state_backend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_loader.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_graph_decoder.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_graph_encoder.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_beam_search.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/nmt_utils.cpp
)

# Add bergamot source files if enabled
if(USE_BERGAMOT)
  target_sources(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bergamot.cpp
  )
endif()
target_include_directories(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

# Add bergamot include directories if enabled
if(USE_BERGAMOT)
  target_include_directories(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${PROJECT_SOURCE_DIR}/third-party/bergamot-translator/src
      ${PROJECT_SOURCE_DIR}/third-party/bergamot-translator
  )
endif()

target_compile_definitions(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    JS_LOGGER
)

# Add bergamot compile definition if enabled
if(USE_BERGAMOT)
  target_compile_definitions(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      HAVE_BERGAMOT
  )
endif()

if(DEFINED SENTENCEPIECE_INCLUDE_DIRS)
  target_include_directories(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${SENTENCEPIECE_INCLUDE_DIRS}
  )
endif()

# Link core dependencies
target_link_libraries(
  ${qvac-lib-infer-nmtcpp}
  PRIVATE
    ggml::ggml
)

# When using Bergamot, we configured SPM_PROTOBUF_PROVIDER=package, which means sentencepiece
# uses external protobuf (from vcpkg) instead of its built-in protobuf-lite.
# Therefore, we must link vcpkg's protobuf to provide the protobuf symbols.
# Note: Bergamot includes its own sentencepiece, so we don't link vcpkg's sentencepiece.
if(USE_BERGAMOT)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      protobuf::libprotobuf
  )
else()
  # When NOT using Bergamot, link vcpkg's sentencepiece and protobuf
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      ${SENTENCEPIECE_TARGET}
      protobuf::libprotobuf
  )
endif()

if(absl_FOUND)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      absl::flags
      absl::flags_internal
  )
endif()

# Link bergamot library if enabled
if(USE_BERGAMOT)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      bergamot-translator
  )
endif()

if(WIN32)
  target_link_libraries(
    ${qvac-lib-infer-nmtcpp}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(addon/tests)
endif()


