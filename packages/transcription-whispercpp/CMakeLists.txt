cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(transcription-whispercpp CXX C)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")
find_package(whisper CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Define _DEBUG for debug builds
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI )
endif()

# Required by Tokenizers
if(ANDROID)
  set(ANDROID_TOOLCHAIN_ROOT "$ENV{ANDROID_TOOLCHAIN_ROOT}")
  set(ANDROID_NATIVE_API_LEVEL "$ENV{ANDROID_NATIVE_API_LEVEL}")
endif()

set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if(NOT TARGET ggml::${_backend})
      # GGML_BACKEND_DL=ON ships the per-arch CPU + GPU backends as
      # standalone MODULE libraries that are dlopen'd at runtime; upstream
      # ggml's install(TARGETS … EXPORT) skips them, so materialise an
      # imported target from the .so under vcpkg's bin/.
      find_library(_${_backend}_LIB
        NAMES "${_backend}"
        PATHS "${VCPKG_INSTALLED_PATH}/bin" "${VCPKG_INSTALLED_PATH}/lib"
        NO_DEFAULT_PATH
        REQUIRED)
      add_library(ggml::${_backend} SHARED IMPORTED)
      set_target_properties(ggml::${_backend} PROPERTIES
        IMPORTED_LOCATION "${_${_backend}_LIB}"
        IMPORTED_NO_SONAME TRUE)
    endif()
    list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()

# Subdir bare's runtime installs the dlopenable backend modules into
# (<addon>/prebuilds/<bare_target>/<module_name>/); WhisperModel joins it
# with the runtime-supplied backendsDir before
# ggml_backend_load_all_from_path().
bare_target(bare_target_value)
bare_module_target("." _unused_target NAME module_name VERSION _unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")

add_bare_module(transcription-whispercpp EXPORTS ${BACKEND_DL_LIBS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${transcription-whispercpp}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${transcription-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/StreamingProcessor.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperConfig.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.hpp
)

target_include_directories(
  ${transcription-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${transcription-whispercpp}
  PRIVATE
    whisper::whisper
)

target_compile_definitions(${transcription-whispercpp} PUBLIC JS_LOGGER)
target_compile_definitions(${transcription-whispercpp} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

if(WIN32)
  target_link_libraries(
    ${transcription-whispercpp}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
  find_package(GTest REQUIRED)

  # Create whisper-core library for testing
  set(CORE_SRCS
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/StreamingProcessor.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperConfig.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperModel.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.hpp
  )

  add_library(whisper-core STATIC ${CORE_SRCS})

  target_link_libraries(whisper-core PRIVATE
      whisper::whisper
  )

  target_include_directories(whisper-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  # Create test executable
  add_executable(
      test-whisper-core
      ${PROJECT_SOURCE_DIR}/addon/tests/test_core.cpp
      ${PROJECT_SOURCE_DIR}/addon/tests/AddonCppTest.cpp
  )

  target_include_directories(test-whisper-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${PROJECT_SOURCE_DIR}/addon/tests/
      ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  target_link_libraries(test-whisper-core PRIVATE 
      whisper-core 
      whisper::whisper 
      GTest::gtest_main 
      GTest::gmock
  )

  # Set the output directory for test executable
  set_target_properties(test-whisper-core PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/addon/tests
  )

  # Coverage configuration
  if(ENABLE_COVERAGE)
      # Use LLVM coverage flags
      target_compile_options(test-whisper-core PRIVATE 
          -fprofile-instr-generate 
          -fcoverage-mapping
      )
      target_compile_options(whisper-core PRIVATE 
          -fprofile-instr-generate 
          -fcoverage-mapping
      )
      # Link against LLVM profile runtime
      target_link_options(test-whisper-core PRIVATE 
          -fprofile-instr-generate
      )
      message(STATUS "LLVM Coverage enabled for whisper-core tests")
  endif()
endif()