# qvac-addon.cmake — shared CMake helpers for QVAC native inference addons.
#
# See docs/architecture/ADDON-CMAKE-TEMPLATE.md for the design rationale, the
# common-vs-addon-specific breakdown, and the migration plan.
#
# Addons include this module once, then call the helpers:
#
#   include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
#   qvac_addon_preproject()                 # BEFORE project()
#   project(<name> LANGUAGES C CXX)
#   qvac_addon_project_setup()              # AFTER project()
#   qvac_addon_use_fabric()                 # sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE
#   add_bare_module(<name> EXPORTS)
#   ...target_sources / target_include_directories...
#   qvac_addon_link_fabric(${<name>} ${qvac_fabric_target})
#   qvac_addon_finalize(${<name>} SUBDIR "${BACKENDS_SUBDIR_VALUE}")
#
# qvac_addon_preproject / _project_setup / _use_fabric are macros on purpose:
# they set directory-scope state (VCPKG_MANIFEST_FEATURES, the vcpkg toolchain,
# ANDROID_STL, CMAKE_CXX_STANDARD, the fabric target var, ...) that must land in
# the addon's own scope, not a nested function scope.

include_guard(GLOBAL)

set(QVAC_ADDON_CMAKE_VERSION "0.1.0")

# ---------------------------------------------------------------------------
# qvac_addon_preproject()
#
# Pre-project() setup shared by every addon. Must run BEFORE project() so the
# vcpkg toolchain, manifest features and Android STL are in effect when the
# toolchain file loads.
# ---------------------------------------------------------------------------
macro(qvac_addon_preproject)
  option(BUILD_TESTING "Build tests" OFF)
  option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)
  if(BUILD_TESTING)
    list(APPEND VCPKG_MANIFEST_FEATURES "tests")
  endif()

  find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
  find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

  set(VCPKG_OVERLAY_TRIPLETS
      "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

  # Android STL configuration must be set before project().
  if(DEFINED ENV{ANDROID_NDK} OR DEFINED ENV{ANDROID_NDK_HOME})
    set(ANDROID_STL c++_shared)
  endif()

  message(STATUS "qvac-addon: template v${QVAC_ADDON_CMAKE_VERSION}")
endmacro()

# ---------------------------------------------------------------------------
# qvac_addon_project_setup([VALGRIND_SUPP] [PRE_COMMIT_HOOK])
#
# Post-project() setup: libc++ on Linux, lint-cpp config sync, the C++20 block,
# and Windows lean-headers defines. `.clang-format` / `.clang-tidy` are always
# synced from lint-cpp; the valgrind suppression file and the pre-commit hook
# are opt-in (most addons want them; a few historically didn't).
# ---------------------------------------------------------------------------
macro(qvac_addon_project_setup)
  cmake_parse_arguments(_QAPS "VALGRIND_SUPP;PRE_COMMIT_HOOK" "" "" ${ARGN})

  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_compile_options(-stdlib=libc++)
    add_link_options(-stdlib=libc++ -static-libstdc++)
  endif()

  find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
  configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
                 ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
  configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
                 ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
  if(_QAPS_VALGRIND_SUPP)
    configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.valgrind.supp
                   ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
  endif()
  if(_QAPS_PRE_COMMIT_HOOK)
    configure_file(${VCPKG_INSTALLED_PATH}/tools/lint-cpp/hooks/pre-commit
                   ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)
  endif()

  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_EXTENSIONS OFF)
  set(CMAKE_POSITION_INDEPENDENT_CODE ON)
  set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

  if(WIN32)
    add_definitions(-DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI)
  endif()
endmacro()

# ---------------------------------------------------------------------------
# qvac_addon_use_fabric()
#
# Consume the shared @qvac/fabric prebuilt ggml runtime. Sets, in the caller's
# scope:
#   qvac_fabric_target    — the fabric bare-module target (link its _module)
#   BACKENDS_SUBDIR_VALUE  — "<host>/qvac__fabric": the subdir the addon appends
#                            to the runtime-provided backendsDir before calling
#                            ggml_backend_load_all_from_path().
#
# The ggml compute backends live in @qvac/fabric's own prebuilds and are loaded
# once per process; the addon neither collects nor installs them.
# ---------------------------------------------------------------------------
macro(qvac_addon_use_fabric)
  set(qvac-fabric_DIR
      "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/fabric/prebuilds/share/qvac-fabric/cmake")
  find_package(qvac-fabric CONFIG REQUIRED)
  include_bare_module("@qvac/fabric" qvac_fabric_target PREBUILD)

  bare_target(bare_target_value)
  set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/qvac__fabric")
  message(STATUS "qvac-addon: BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")
endmacro()

# ---------------------------------------------------------------------------
# qvac_addon_link_fabric(<addon_target> <fabric_target>)
#
# The two-target link split: compile the addon library against the ggml headers,
# and give the .bare module a DT_NEEDED on the shared runtime.
# ---------------------------------------------------------------------------
function(qvac_addon_link_fabric addon_target fabric_target)
  target_link_libraries(${addon_target} PRIVATE qvac-fabric::headers)
  target_link_libraries(${addon_target}_module PRIVATE ${fabric_target}_module)
endfunction()

# ---------------------------------------------------------------------------
# qvac_addon_finalize(<addon_target> [SUBDIR <value>])
#
# Apply the settings every addon module needs:
#   * Linux symbol hygiene (--exclude-libs,ALL),
#   * JS_LOGGER + BACKENDS_SUBDIR compile definitions,
#   * platform-derived GGML_BACKEND_DL (Linux/Android load ggml backends as
#     dlopen'd modules; macOS/Windows/iOS link them static into the runtime),
#   * Android 16 KB page-size link flags,
#   * Apple compiler-rt force_load for __isPlatformVersionAtLeast.
#
# The last two normalize fixes that had drifted across addons: they are applied
# to every module so an addon can never silently miss them. They are no-ops on
# platforms they don't target (guarded by ANDROID / APPLE).
# ---------------------------------------------------------------------------
function(qvac_addon_finalize addon_target)
  cmake_parse_arguments(PARSE_ARGV 1 _QAF "" "SUBDIR" "")

  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_options(${addon_target}_module PRIVATE -Wl,--exclude-libs,ALL)
  endif()

  target_compile_definitions(${addon_target} PRIVATE JS_LOGGER)
  if(_QAF_SUBDIR)
    target_compile_definitions(${addon_target} PRIVATE
      BACKENDS_SUBDIR="${_QAF_SUBDIR}")
  endif()

  if((ANDROID OR UNIX) AND NOT APPLE)
    target_compile_definitions(${addon_target} PRIVATE GGML_BACKEND_DL)
  endif()

  qvac_addon_android_page_size(${addon_target})
  qvac_addon_apple_force_load_compiler_rt(${addon_target})
endfunction()

# ---------------------------------------------------------------------------
# qvac_addon_android_page_size(<addon_target>)
#
# Android 15+ on Pixel 9 / Pixel 9 Pro / Pixel 9 Pro XL ships with a 16 KB
# page-size kernel (`getconf PAGE_SIZE` -> 16384). The dynamic loader on those
# devices silently refuses .so files whose LOAD segments are aligned to the
# older 4 KB max-page-size, which is what NDK r27 still emits by default (NDK
# r28 flipped the default). Without this flag the addon never registers via
# bare-kit's linker (Bare's resolver reports
# `ADDON_NOT_FOUND: linked:libqvac__<addon>.*.so`) while the same APK loads
# fine on 4 KB devices like the Samsung S25 Ultra. Drop once we move to NDK r28+.
# ---------------------------------------------------------------------------
function(qvac_addon_android_page_size addon_target)
  if(ANDROID)
    target_link_options(
      ${addon_target}_module
      PRIVATE
        -Wl,-z,max-page-size=16384
        -Wl,-z,common-page-size=16384
    )
  endif()
endfunction()

# ---------------------------------------------------------------------------
# qvac_addon_apple_force_load_compiler_rt(<addon_target>)
#
# Force-load clang's compiler-rt builtins archive so `__isPlatformVersionAtLeast`
# -- the symbol that lowers every Objective-C `@available(...)` runtime check --
# resolves at link time.
#
# Why this is needed:
#   Xcode 16 / iOS SDK 18 changed clang's `@available` lowering from a direct
#   call to libSystem's `_availability_version_check` to a compiler-rt wrapper
#   `__isPlatformVersionAtLeast` (clang commit D90367). cmake-bare links every
#   Apple bare module with `-Wl,-undefined,dynamic_lookup`, so ld defers the
#   symbol to dyld; but compiler-rt is a static archive dyld can't load, so the
#   symbol binds to NULL and the first `@available` call jumps to PC=0 and the
#   bare runtime aborts. `-Wl,-force_load,<archive>` is the only ld primitive
#   that bypasses `-undefined,dynamic_lookup` and pulls the builtins in.
#
# We resolve the right libclang_rt.<variant>.a at configure time via Xcode's
# clang (not ${CMAKE_C_COMPILER}, which may be Homebrew LLVM that only ships the
# macOS variant). Long-term this belongs in cmake-bare itself.
# ---------------------------------------------------------------------------
function(qvac_addon_apple_force_load_compiler_rt addon_target)
  if(NOT APPLE)
    return()
  endif()

  # Map the active CMake target to (a) the xcrun SDK name and (b) clang's
  # libclang_rt filename suffix. ld's search uses the exact filename, so picking
  # the wrong variant silently leaves the symbol unresolved.
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
  message(STATUS "${addon_target}: force-loading ${_qvac_clang_rtlib} "
                 "to satisfy clang @available -> __isPlatformVersionAtLeast")

  target_link_options(
    ${addon_target}_module
    PRIVATE
      "SHELL:-Wl,-force_load,${_qvac_clang_rtlib}"
  )
endfunction()

# ---------------------------------------------------------------------------
# qvac_addon_stage_fabric_for_test(<test_target> <fabric_target>)
#
# Test-only wiring for a plain add_executable() that links the shared fabric
# runtime (production .bare modules get this from add_bare_module()):
#   * GGML_BACKEND_DL / GGML_BACKEND_DIR so backend_env.cpp preloads the ggml
#     backend modules from the test binary dir,
#   * copy qvac__fabric@0.bare next to the test binary,
#   * stage @qvac/fabric's dlopen'd ggml backends (Linux/Android) alongside it,
#   * $ORIGIN / @loader_path rpath so the copies resolve,
#   * the Windows delay-load helper the imported module target doesn't carry.
# ---------------------------------------------------------------------------
function(qvac_addon_stage_fabric_for_test test_target fabric_target)
  if((ANDROID OR UNIX) AND NOT APPLE)
    target_compile_definitions(${test_target} PRIVATE GGML_BACKEND_DL)
  endif()
  target_compile_definitions(${test_target} PRIVATE
    GGML_BACKEND_DIR="${CMAKE_CURRENT_BINARY_DIR}")

  if(WIN32)
    target_link_libraries(${test_target} PRIVATE bare_delay_load)
  endif()

  add_custom_command(TARGET ${test_target} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      $<TARGET_FILE:${fabric_target}_module>
      ${CMAKE_CURRENT_BINARY_DIR}/qvac__fabric@0.bare
    COMMENT "Copying qvac__fabric@0.bare to test directory")

  bare_target(_qvac_host)
  file(GLOB _qvac_fabric_test_backends
    "${CMAKE_SOURCE_DIR}/node_modules/@qvac/fabric/prebuilds/${_qvac_host}/qvac__fabric/*.so")
  if(_qvac_fabric_test_backends)
    add_custom_command(TARGET ${test_target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${_qvac_fabric_test_backends}
        ${CMAKE_CURRENT_BINARY_DIR}/
      COMMENT "Staging @qvac/fabric ggml backends next to ${test_target}")
  endif()

  if(APPLE)
    set_target_properties(${test_target} PROPERTIES BUILD_RPATH "@loader_path")
  elseif(NOT WIN32)
    set_target_properties(${test_target} PROPERTIES BUILD_RPATH "$ORIGIN")
  endif()
endfunction()
