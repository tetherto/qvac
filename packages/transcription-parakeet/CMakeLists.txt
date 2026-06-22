cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage" OFF)

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

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

find_path(
  QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/ModelInterfaces.hpp"
  REQUIRED
)

find_package(parakeet-cpp CONFIG REQUIRED)
find_package(ggml CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI )
endif()

# Bare module subfolder for dynamically-loadable ggml backends. Same
# shape qvac/packages/llm-llamacpp uses: cmake-bare derives the
# subdir from `<bare_target>/<module_name>` (e.g.
# `android-arm64/qvac__transcription-parakeet`) and installs the
# .so / .dll / .dylib backend files there. The runtime resolves the
# directory via the same shape on the JS side
# (`path.join(__dirname, 'prebuilds')`), then ParakeetConfig.backendsDir
# is forwarded to parakeet::EngineOptions::backends_dir which calls
# `ggml_backend_load_all_from_path()` against it. The C++ define
# below tells the addon what relative subdir to scan under that root.
bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message(STATUS "Building qvac_lib_infer_parakeet with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# Collect every dynamically-loadable ggml backend surfaced by the
# ggml-speech port as an IMPORTED target. On Android the IMPORTED set is
# CPU-only (Vulkan/OpenCL ship as loose MODULE .so -- staged below);
# nothing is staged on Apple/static-only platforms. cmake-bare's
# `add_bare_module(... EXPORTS INSTALL TARGET <tgt>)` bundles each
# IMPORTED ggml::<backend> target into the per-arch prebuilds folder
# next to the `.bare` module. Mirrors qvac/packages/llm-llamacpp/
# CMakeLists.txt lines 56-64 verbatim for the IMPORTED targets path.
#
# Hybrid-mode caveat: the ggml-speech vcpkg port builds Android with
# GGML_BACKEND_DL=ON + GGML_CPU_STATIC=ON, so only the CPU backend
# ships as a static archive AND as an IMPORTED ggml::ggml-cpu target;
# Vulkan / OpenCL can also be built as MODULE .so files at
# `${VCPKG_INSTALLED_PATH}/lib/libqvac-speech-ggml-{vulkan,opencl}.so`
# but ggml-config.cmake.in deliberately leaves them out of
# GGML_AVAILABLE_BACKENDS' IMPORTED set (the loader is expected to
# find them via `ggml_backend_load_all_from_path()` at runtime).
# We stage those GPU modules on Android too (loose-glob below) so the
# engine can select Vulkan/OpenCL per ggml's Adreno-tier policy when
# useGPU=true; ggml falls back to CPU on devices it can't drive.
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if(TARGET ggml::${_backend})
      list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
    endif()
  endforeach()
endif()

# Loose-file pickup for MODULE backends that aren't surfaced as
# IMPORTED targets by find_package(ggml). On Android (as on Linux) we
# stage every ggml-speech backend .so -- CPU per-arch variants plus the
# Vulkan/OpenCL MODULE libs -- so `ggml_backend_load_all_from_path()`
# can discover and select a GPU backend at runtime when useGPU=true.
# Glob runs at configure time -- the .so files come from ggml-speech's
# `file(INSTALL ...)` step in its portfile, which has already completed
# by the time vcpkg hands control back to us. Apple / Windows
# static-only configs return an empty list and skip the install rule.
set(BACKEND_DL_LOOSE_SOS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  if(NOT VCPKG_INSTALLED_PATH OR NOT EXISTS "${VCPKG_INSTALLED_PATH}/lib")
    message(WARNING "qvac_lib_infer_parakeet: VCPKG_INSTALLED_PATH "
      "('${VCPKG_INSTALLED_PATH}') has no lib/ dir; skipping loose "
      "ggml backend .so pickup -- the runtime may fail to find "
      "Android CPU backend modules.")
  else()
    file(GLOB BACKEND_DL_LOOSE_SOS
      "${VCPKG_INSTALLED_PATH}/lib/libqvac-speech-ggml-*.so")
    foreach(_lib IN LISTS BACKEND_DL_LOOSE_SOS)
      message(STATUS "qvac_lib_infer_parakeet: will stage ggml backend ${_lib}")
    endforeach()
  endif()
endif()

set(LIB_NAME parakeet_model_core)
set(LIB_SRCS_PATH ${PROJECT_SOURCE_DIR}/addon/src/model-interface)

set(LIB_SRCS
        ${LIB_SRCS_PATH}/ParakeetTypes.hpp
        ${LIB_SRCS_PATH}/ParakeetStreamingProcessor.hpp
        ${LIB_SRCS_PATH}/ParakeetStreamingProcessor.cpp
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

add_bare_module(qvac_lib_infer_parakeet EXPORTS ${BACKEND_DL_LIBS})

# Stage every loose MODULE backend selected above
# into the same per-host/per-module subdir cmake-bare's INSTALL TARGET
# branch uses for IMPORTED targets (see cmake-bare.cmake lines 458-472:
# `DESTINATION ${host}/${name}` -- e.g. `android-arm64/qvac__transcription-parakeet`).
# Keeping the destinations identical means
# `ggml_backend_load_all_from_path(backendsDir / BACKENDS_SUBDIR)`
# on the C++ side discovers IMPORTED-target CPU and loose-file
# CPU backends with a single scan.
if(BACKEND_DL_LOOSE_SOS)
  install(
    FILES ${BACKEND_DL_LOOSE_SOS}
    DESTINATION ${bare_target_value}/${module_name}
  )
endif()

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
# Same value the JS side appends to the host-provided `backendsDir`
# default (`path.join(__dirname, 'prebuilds', <subdir>)`). Defining
# it here lets the addon compute the full backends path from a
# host-provided prebuilds root without the host needing to know the
# `<bare-target>/<module-name>` shape itself.
target_compile_definitions(${qvac_lib_infer_parakeet} PRIVATE
  BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

target_link_libraries(${LIB_NAME} PRIVATE
    parakeet::parakeet
    ggml::ggml
)

target_link_libraries(
  ${qvac_lib_infer_parakeet}
  PRIVATE
    ${LIB_NAME}
    parakeet::parakeet
    ggml::ggml
)
if(WIN32)
  target_compile_options(${qvac_lib_infer_parakeet} PRIVATE "/utf-8")

  target_link_libraries(
    ${qvac_lib_infer_parakeet}
    PRIVATE
      msvcrt.lib
  )
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
endif()

# Android 15+ on Pixel 9 / Pixel 9 Pro / Pixel 9 Pro XL ships with a
# 16 KB page size kernel (`getconf PAGE_SIZE` -> 16384). The dynamic
# loader on those devices silently refuses .so files whose LOAD
# segments are aligned to the older 4 KB max-page-size, which is what
# NDK r27 still emits by default (NDK r28 flipped the default). Without
# this flag the addon never registers via bare-kit's linker (Bare's
# resolver then reports `ADDON_NOT_FOUND: linked:libqvac__transcription-parakeet.*.so`)
# while the same APK loads fine on 4 KB devices like the Samsung S25
# Ultra. Drop the flag once we move to NDK r28+.
if(ANDROID)
  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      -Wl,-z,max-page-size=16384
      -Wl,-z,common-page-size=16384
  )
endif()

if(APPLE)
  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )

  # Force-load clang's compiler-rt builtins archive so the
  # `__isPlatformVersionAtLeast` symbol that lowers every Objective-C
  # `@available(...)` runtime check resolves at link time.
  #
  # Why this is needed:
  #   Xcode 16 / iOS SDK 18 changed clang's `@available` lowering
  #   from a direct call to libSystem's `_availability_version_check`
  #   to a compiler-rt wrapper called `__isPlatformVersionAtLeast`
  #   (clang commit D90367). Older SDKs (e.g. 17.5, what the
  #   currently published whispercpp / llama prebuilds were built
  #   against) still emit the libSystem variant, which is always
  #   resolvable at runtime; SDK 18 builds emit the compiler-rt
  #   wrapper instead, which only lives in libclang_rt.<platform>.a.
  #
  #   cmake-bare links every Apple bare module with
  #   `-Wl,-undefined,dynamic_lookup`, telling ld it's fine to leave
  #   any external undefined and defer it to dyld at load time. With
  #   that flag in effect, neither `-fapple-link-rtlib` (which only
  #   adds `-lclang_rt.<platform>` to the link line) nor
  #   `-Wl,-u,___isPlatformVersionAtLeast` (which adds the symbol as
  #   a "demand") manages to pull the wrapper out: ld sees the demand
  #   as already satisfiable via dynamic_lookup and skips compiler-rt
  #   entirely. dyld then can't find the symbol either (compiler-rt
  #   is a *static* archive, not a dyld-loadable image) and leaves
  #   it bound to NULL. The first `@available` call from inside the
  #   loaded module -- on parakeet that's the
  #   `__ggml_metal_rsets_init_block_invoke` dispatch_async block
  #   on iOS 18 -- then jumps to PC=0 and the bare runtime aborts.
  #
  #   `-Wl,-force_load,<archive>` is the only ld primitive that
  #   bypasses `-undefined,dynamic_lookup`: it's a positive directive
  #   ("include every .o from this archive") rather than a demand
  #   that dynamic_lookup can defer. We resolve the right
  #   libclang_rt variant at configure time -- iossim / ios / osx /
  #   maccatalyst / etc. -- by walking clang's resource dir, then
  #   force-load just that one archive.
  #
  # Long-term this belongs in cmake-bare itself so every bare module
  # is robust against `-undefined,dynamic_lookup` swallowing
  # compiler-rt builtins. Same fix will be needed in
  # llm-llamacpp / transcription-whispercpp / tts-ggml the moment
  # any of them gets rebuilt under Xcode 16+.
  # Map the active CMake target to (a) the xcrun SDK name we'll ask
  # Xcode's clang about and (b) clang's libclang_rt filename suffix.
  # ld's search uses the exact filename, so picking the wrong variant
  # silently leaves the symbol unresolved (same failure mode this
  # whole block exists to fix).
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
  message(STATUS "qvac_lib_infer_parakeet: force-loading ${_qvac_clang_rtlib} "
                 "to satisfy clang @available -> __isPlatformVersionAtLeast")

  target_link_options(
    ${qvac_lib_infer_parakeet}_module
    PRIVATE
      "SHELL:-Wl,-force_load,${_qvac_clang_rtlib}"
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

    target_link_libraries(parakeet_tests
      PRIVATE
        GTest::gmock_main
        parakeet::parakeet
        ggml::ggml
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

    # CI invokes the test binary directly via npm scripts, so avoid running it
    # during build-time discovery where libc++/coverage combinations have been
    # aborting before the actual test step starts.
    add_test(NAME parakeet_tests COMMAND parakeet_tests)
endif()
