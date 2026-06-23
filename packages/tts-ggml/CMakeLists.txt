cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage" OFF)
option(ENABLE_VULKAN "Enable Vulkan GPU acceleration" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

if(ENABLE_VULKAN)
  list(APPEND VCPKG_MANIFEST_FEATURES "vulkan")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(tts-ggml CXX C)

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
find_package(tts-cpp CONFIG REQUIRED)
# Pull in ggml directly (in addition to the transitive
# find_package(ggml) that tts-cppConfig.cmake already does) so the
# `GGML_AVAILABLE_BACKENDS` list and per-backend `ggml::<backend>`
# IMPORTED targets are visible in *this* listfile's scope. We need
# them for the dynamic-backend install plumbing below.
find_package(ggml CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

# Bare module subfolder for dynamically-loadable ggml backends. Same
# shape qvac/packages/transcription-parakeet + llm-llamacpp use:
# cmake-bare derives the subdir from `<bare_target>/<module_name>`
# (e.g. `android-arm64/qvac__tts-ggml`) and installs the
# .so / .dll / .dylib backend files there. The runtime resolves the
# directory via the same shape on the JS side
# (`path.join(__dirname, 'prebuilds')`); ChatterboxConfig.backendsDir
# and SupertonicConfig.backendsDir will be forwarded to the new
# `tts_cpp::{chatterbox,supertonic}::EngineOptions::backends_dir`
# field (calls `ggml_backend_load_all_from_path()` against it) once
# the JS / C++ wiring lands. The C++ define below tells the addon
# what relative subdir to scan under that root.
bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message(STATUS "Building tts-ggml with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# Collect every dynamically-loadable ggml backend the ggml-speech port
# produced ($CURRENT_PACKAGES_DIR/lib/libqvac-speech-ggml-*.so on
# Android; nothing on Apple/static-only platforms). cmake-bare's
# `add_bare_module(... EXPORTS INSTALL TARGET <tgt>)` bundles each
# IMPORTED `ggml::<backend>` target into the per-arch prebuilds folder
# next to the `.bare` module. Mirrors qvac/packages/transcription-
# parakeet/CMakeLists.txt's BACKEND_DL_LIBS path.
#
# Hybrid-mode caveat: the ggml-speech vcpkg port builds Android with
# GGML_BACKEND_DL=ON + GGML_CPU_STATIC=ON, so only the CPU backend
# ships as a static archive AND as an IMPORTED `ggml::ggml-cpu` target;
# Vulkan / OpenCL get built as MODULE .so files at
# `${VCPKG_INSTALLED_PATH}/lib/libqvac-speech-ggml-{vulkan,opencl}.so`
# but ggml-config.cmake.in deliberately leaves them out of
# `GGML_AVAILABLE_BACKENDS`' IMPORTED set (the loader is expected to
# find them via `ggml_backend_load_all_from_path()` at runtime). We
# pick those up with an explicit `install(FILES ...)` below so the
# runtime scan against BACKENDS_SUBDIR actually finds them next to
# the .bare module.
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if(TARGET ggml::${_backend})
      list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
    endif()
  endforeach()
endif()

# Loose-file pickup for MODULE backends that aren't surfaced as
# IMPORTED targets by find_package(ggml). On Android this is what
# actually delivers Vulkan + OpenCL into the prebuilds folder; we
# do the same on Linux as a fallback for any future hybrid build
# there. Glob runs at configure time -- the .so files come from
# ggml-speech's `file(INSTALL ...)` step in its portfile, which has
# already completed by the time vcpkg hands control back to us. Apple
# / Windows static-only configs return an empty list and skip the
# install rule below.
set(BACKEND_DL_LOOSE_SOS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  if(NOT VCPKG_INSTALLED_PATH OR NOT EXISTS "${VCPKG_INSTALLED_PATH}/lib")
    message(WARNING "tts-ggml: VCPKG_INSTALLED_PATH "
      "('${VCPKG_INSTALLED_PATH}') has no lib/ dir; skipping loose "
      "ggml backend .so pickup -- the runtime may fail to find "
      "Vulkan / OpenCL backends.")
  else()
    file(GLOB BACKEND_DL_LOOSE_SOS
      "${VCPKG_INSTALLED_PATH}/lib/libqvac-speech-ggml-*.so")
    foreach(_lib IN LISTS BACKEND_DL_LOOSE_SOS)
      message(STATUS "tts-ggml: will stage ggml backend ${_lib}")
    endforeach()
  endif()
endif()

add_bare_module(tts-ggml EXPORTS ${BACKEND_DL_LIBS})

# Stage every loose MODULE backend (Vulkan / OpenCL on Android, ...)
# into the same per-host/per-module subdir cmake-bare's INSTALL TARGET
# branch uses for IMPORTED targets (see cmake-bare.cmake's
# `DESTINATION ${host}/${name}` -- e.g. `android-arm64/qvac__tts-ggml`).
# Keeping the destinations identical means
# `ggml_backend_load_all_from_path(backendsDir / BACKENDS_SUBDIR)`
# on the C++ side discovers IMPORTED-target CPU and loose-file
# GPU backends with a single scan.
if(BACKEND_DL_LOOSE_SOS)
  install(
    FILES ${BACKEND_DL_LOOSE_SOS}
    DESTINATION ${bare_target_value}/${module_name}
  )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${tts-ggml}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/chatterbox/ChatterboxModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/supertonic/SupertonicModel.cpp
)

target_include_directories(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${tts-ggml}
  PRIVATE
    tts-cpp::tts-cpp
)

target_compile_definitions(${tts-ggml} PUBLIC JS_LOGGER)
# Same value the JS side appends to the host-provided `backendsDir`
# default (`path.join(__dirname, 'prebuilds', <subdir>)`). Defining
# it here lets the addon compute the full backends path from a
# host-provided prebuilds root without the host needing to know the
# `<bare-target>/<module-name>` shape itself. Mirrors
# qvac/packages/transcription-parakeet/CMakeLists.txt.
target_compile_definitions(${tts-ggml} PRIVATE
  BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

# Android 15+ on Pixel 9 / Pixel 9 Pro / Pixel 9 Pro XL ships with a
# 16 KB page size kernel (`getconf PAGE_SIZE` -> 16384). The dynamic
# loader on those devices silently refuses .so files whose LOAD
# segments are aligned to the older 4 KB max-page-size, which is what
# NDK r27 still emits by default (NDK r28 flipped the default).
# Without this flag the addon never registers via bare-kit's linker
# (Bare's resolver then reports
# `ADDON_NOT_FOUND: linked:libqvac__tts-ggml.*.so`) while the same APK
# loads fine on 4 KB devices like the Samsung S25 Ultra. Mirrors
# qvac/packages/transcription-parakeet/CMakeLists.txt; drop the flag
# once we move to NDK r28+.
if(ANDROID)
  target_link_options(
    ${tts-ggml}_module
    PRIVATE
      -Wl,-z,max-page-size=16384
      -Wl,-z,common-page-size=16384
  )
endif()

if(APPLE)
  target_link_options(
    ${tts-ggml}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )

  # Force-load clang's compiler-rt builtins archive so the
  # `__isPlatformVersionAtLeast` symbol that lowers every Objective-C
  # `@available(...)` runtime check resolves at link time.
  if(IOS)
    if(CMAKE_OSX_SYSROOT MATCHES "Simulator")
      set(_qvac_rtlib_variant "iossim")
      set(_qvac_xcrun_sdk      "iphonesimulator")
    else()
      set(_qvac_rtlib_variant "ios")
      set(_qvac_xcrun_sdk      "iphoneos")
    endif()
  elseif(CMAKE_SYSTEM_NAME STREQUAL "tvOS")
    if(CMAKE_OSX_SYSROOT MATCHES "Simulator")
      set(_qvac_rtlib_variant "tvossim")
      set(_qvac_xcrun_sdk      "appletvsimulator")
    else()
      set(_qvac_rtlib_variant "tvos")
      set(_qvac_xcrun_sdk      "appletvos")
    endif()
  elseif(CMAKE_SYSTEM_NAME STREQUAL "watchOS")
    if(CMAKE_OSX_SYSROOT MATCHES "Simulator")
      set(_qvac_rtlib_variant "watchossim")
      set(_qvac_xcrun_sdk      "watchsimulator")
    else()
      set(_qvac_rtlib_variant "watchos")
      set(_qvac_xcrun_sdk      "watchos")
    endif()
  else()
    set(_qvac_rtlib_variant "osx")
    set(_qvac_xcrun_sdk      "macosx")
  endif()

  # Resolve clang's resource dir via xcrun against the same SDK we're
  # building for. We deliberately do NOT use ${CMAKE_C_COMPILER} -- on
  # this build host that points at Homebrew's llvm@19, whose
  # compiler-rt only carries the macOS variants (iOS/tvOS/watchOS
  # libclang_rt.<platform>.a only ship inside Xcode). Going through
  # `xcrun --sdk <sdk> clang` always lands on Xcode's clang for the
  # right SDK so the iOS / iOS-simulator / etc. variants are present.
  execute_process(
    COMMAND xcrun --sdk "${_qvac_xcrun_sdk}" clang -print-resource-dir
    OUTPUT_VARIABLE _qvac_clang_resource_dir
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE _qvac_clang_resource_dir_result
    ERROR_QUIET
  )
  if(NOT _qvac_clang_resource_dir_result EQUAL 0
     OR NOT IS_DIRECTORY "${_qvac_clang_resource_dir}/lib/darwin")
    message(FATAL_ERROR
      "Apple bare-module link needs Xcode clang's compiler-rt for "
      "__isPlatformVersionAtLeast (Xcode 16 / iOS SDK 18 @available "
      "lowering). `xcrun --sdk ${_qvac_xcrun_sdk} clang -print-resource-dir`"
      " returned '${_qvac_clang_resource_dir}' but lib/darwin/ doesn't "
      "exist there. Verify Xcode + the ${_qvac_xcrun_sdk} SDK are "
      "installed (`xcrun --sdk ${_qvac_xcrun_sdk} --show-sdk-path` "
      "should resolve).")
  endif()

  set(_qvac_clang_rtlib
    "${_qvac_clang_resource_dir}/lib/darwin/libclang_rt.${_qvac_rtlib_variant}.a")
  if(NOT EXISTS "${_qvac_clang_rtlib}")
    message(FATAL_ERROR
      "Apple bare-module link expected compiler-rt at "
      "'${_qvac_clang_rtlib}' but it doesn't exist. Toolchain layout "
      "may have changed; pick the correct libclang_rt.<variant>.a "
      "for ${CMAKE_SYSTEM_NAME} (sysroot: ${CMAKE_OSX_SYSROOT}).")
  endif()
  message(STATUS "tts-ggml: force-loading ${_qvac_clang_rtlib} "
                 "to satisfy clang @available -> __isPlatformVersionAtLeast")

  target_link_options(
    ${tts-ggml}_module
    PRIVATE
      "SHELL:-Wl,-force_load,${_qvac_clang_rtlib}"
  )
endif()
if(BUILD_TESTING)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)

  # Test exec recompiles ChatterboxModel.cpp + SupertonicModel.cpp from
  # source (rather than linking the bare-module artefact) so coverage
  # instrumentation lands on those translation units.  JSAdapter.cpp is
  # excluded because it depends on Bare's <js.h>, which isn't available
  # outside the bare module link.
  add_executable(
    tts_ggml_tests
      addon/tests/test_backend_utils.cpp
      addon/tests/test_chatterbox_config.cpp
      addon/tests/test_supertonic_config.cpp
      addon/tests/AddonCppTest.cpp
      addon/src/model-interface/chatterbox/ChatterboxModel.cpp
      addon/src/model-interface/supertonic/SupertonicModel.cpp
  )

  target_include_directories(tts_ggml_tests
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon
      ${PROJECT_SOURCE_DIR}/addon/src
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  target_link_libraries(tts_ggml_tests
    PRIVATE
      GTest::gmock_main
      tts-cpp::tts-cpp
  )
  if(ENABLE_COVERAGE)
    # LLVM source-based coverage (clang).  Same flag set parakeet uses.
    target_compile_options(tts_ggml_tests PRIVATE
      -fprofile-instr-generate
      -fcoverage-mapping
    )
    target_link_options(tts_ggml_tests PRIVATE
      -fprofile-instr-generate
    )
    message(STATUS "LLVM Coverage enabled for tts-ggml tests")
  endif()

  # CI invokes the test binary directly via npm scripts (so it can pass
  # gtest_output= and capture results.xml); avoid running the binary
  # during configure-time discovery to keep configure cheap.
  add_test(NAME tts_ggml_tests COMMAND tts_ggml_tests)
endif()
