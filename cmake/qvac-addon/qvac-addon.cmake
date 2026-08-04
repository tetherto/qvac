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
  option(BUILD_FUZZING "Build fuzz targets (Google FuzzTest, from vcpkg)" OFF)
  if(BUILD_TESTING)
    list(APPEND VCPKG_MANIFEST_FEATURES "tests")
  endif()
  # The "fuzz" feature installs the parts of FuzzTest's dependency stack that
  # vcpkg can supply (GoogleTest, the ANTLR4 C++ runtime) so they come from the
  # shared binary cache instead of a per-build-tree source compile. See
  # qvac_addon_enable_fuzztest() and docs/architecture/ADDON-FUZZING.md.
  if(BUILD_FUZZING)
    list(APPEND VCPKG_MANIFEST_FEATURES "fuzz")
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

# ---------------------------------------------------------------------------
# FuzzTest integration (Google FuzzTest).
#
# The whole fuzz dependency stack — FuzzTest, Abseil, RE2, GoogleTest and the
# ANTLR4 C++ runtime — comes from vcpkg, so the shared binary cache serves it
# instead of every build tree cloning and compiling it, and a fuzz configure
# needs no network access of its own. Three of those are QVAC ports in
# qvac-registry-vcpkg for reasons upstream won't fix: `abseil` supplies the
# newer release FuzzTest requires, `re2` installs the internal headers
# FuzzTest's regexp domains include, and `fuzztest` supplies the install() rules
# FuzzTest ships none of. The RE2 and FuzzTest ports are pinned to compatible
# releases and move together.
#
# The consequence worth knowing: the unit tests and the fuzz targets link ONE
# GoogleTest — the vcpkg one — so there is no target-name collision to design
# the build around. See docs/architecture/ADDON-FUZZING.md.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# qvac_addon_enable_fuzztest()
#
# Resolve FuzzTest and its dependencies from vcpkg. Defines the link_fuzztest()
# and link_fuzztest_core() functions in global scope (the `fuzztest` port
# installs FuzzTest's own AddFuzzTest.cmake and its config includes it).
# Idempotent per directory scope: a second call from the same CMakeLists, or from
# a subdirectory of it, is a no-op, so several fuzz targets share one resolution.
# The guard is an INHERITED DIRECTORY property rather than a variable because the
# imported absl::/re2::/fuzztest:: targets find_package() creates are themselves
# visible only in the directory that resolved them plus its subdirectories. A
# variable would not survive the enclosing function call at all; a GLOBAL property
# would wrongly suppress the resolve a sibling directory needs; a CACHE entry would
# survive into the next configure and leave link_fuzztest() undefined.
#
# Requires the "fuzz" vcpkg manifest feature, which qvac_addon_preproject()
# enables whenever BUILD_FUZZING is on.
#
# Pass -DFUZZTEST_FUZZING_MODE=ON at configure time for coverage-guided fuzzing
# mode; the default (OFF) is FuzzTest's unit-test mode, which runs each
# FUZZ_TEST as a bounded GoogleTest. That flag drives only the fuzz target's own
# coverage instrumentation — see qvac_addon_add_fuzz_target() — because the
# fuzzer needs feedback from the code under test, not from FuzzTest's machinery.
# ---------------------------------------------------------------------------
define_property(DIRECTORY PROPERTY _QVAC_ADDON_FUZZTEST_READY INHERITED)

macro(qvac_addon_enable_fuzztest)
  get_property(_qvac_fuzztest_ready DIRECTORY PROPERTY _QVAC_ADDON_FUZZTEST_READY)
  if(NOT _qvac_fuzztest_ready)
    # fuzztest's own config find_dependency()s the other four, but they are
    # named explicitly so a manifest missing the "fuzz" feature fails here
    # naming the package instead of later with an unresolved absl:: link target.
    find_package(absl CONFIG REQUIRED)
    find_package(re2 CONFIG REQUIRED)
    find_package(GTest CONFIG REQUIRED)
    find_package(antlr4-runtime CONFIG REQUIRED)
    find_package(fuzztest CONFIG REQUIRED)
    set_property(DIRECTORY PROPERTY _QVAC_ADDON_FUZZTEST_READY ON)
  endif()
  # A macro body runs in the caller's scope, so drop the probe variable rather
  # than leaking it into whatever called us.
  unset(_qvac_fuzztest_ready)
endmacro()

# ---------------------------------------------------------------------------
# qvac_addon_add_fuzz_target(<target>
#     SOURCES <src>...
#     [INCLUDE_DIRS <dir>...]
#     [LINK_LIBS <lib>...]
#     [LINK_FABRIC])
#
# Build a FuzzTest binary from the given SOURCES (the fuzz driver plus the
# addon TUs under test). The binary works in two modes off the same build:
#   * unit-test mode (default)   — every FUZZ_TEST runs bounded, via ctest.
#   * fuzzing mode               — configure with -DFUZZTEST_FUZZING_MODE=ON,
#                                  then run `<target> --fuzz=Suite.Test`.
#
# The target is linked with AddressSanitizer; without LINK_FABRIC it keeps FULL
# ASan + LeakSanitizer (the fabric prebuild's static-libstdc++ boundary is the
# only thing that forces relaxed ASan options — see qvac_addon_stage_fabric_for_test),
# so prefer fuzzing pure parse/transform code with LINK_FABRIC omitted.
# ---------------------------------------------------------------------------
function(qvac_addon_add_fuzz_target target)
  cmake_parse_arguments(_QAFZ "LINK_FABRIC" "" "SOURCES;INCLUDE_DIRS;LINK_LIBS" ${ARGN})
  if(NOT _QAFZ_SOURCES)
    message(FATAL_ERROR "qvac_addon_add_fuzz_target(${target}): SOURCES required")
  endif()

  qvac_addon_enable_fuzztest()

  add_executable(${target} ${_QAFZ_SOURCES})
  target_compile_features(${target} PRIVATE cxx_std_20)
  target_compile_options(${target} PRIVATE -Wall -Wextra -g)
  if(_QAFZ_INCLUDE_DIRS)
    target_include_directories(${target} PRIVATE ${_QAFZ_INCLUDE_DIRS})
  endif()
  if(_QAFZ_LINK_LIBS)
    target_link_libraries(${target} PRIVATE ${_QAFZ_LINK_LIBS})
  endif()

  link_fuzztest(${target})

  # ASan + LSan, for both run modes.
  if(NOT WIN32)
    target_compile_options(${target} PRIVATE -fsanitize=address -fno-omit-frame-pointer)
    target_link_options(${target} PRIVATE -fsanitize=address)
  endif()

  # Coverage instrumentation for fuzzing mode — without it the fuzzer has no
  # feedback signal on the code under test. FuzzTest's own
  # fuzztest_setup_fuzzing_flags() macro is deliberately NOT used here: it works
  # by appending to CMAKE_CXX_FLAGS, a directory-scoped variable read at generate
  # time, so calling it from inside a function silently discards the flags. The
  # failure is quiet in the worst way — FuzzTest's execution_coverage_ stays null
  # and `--fuzz=` aborts with "To fuzz, please build with --config=fuzztest".
  # Setting the flags on the target instead is scope-proof.
  #
  # Only coverage: this must not change the target's debug/sanitizer posture
  # relative to the FuzzTest libraries it links (e.g. adding -UNDEBUG here). Both
  # halves instantiate the same Abseil container templates, and Abseil's
  # swisstable layout keys off the sanitizer macros, so a posture that differs
  # per TU is an ODR violation that presents as a SIGSEGV inside raw_hash_set.
  if(FUZZTEST_FUZZING_MODE AND NOT WIN32)
    target_compile_options(${target} PRIVATE
      -fsanitize-coverage=inline-8bit-counters
      -fsanitize-coverage=trace-cmp
    )
  endif()

  if(_QAFZ_LINK_FABRIC)
    if(NOT DEFINED qvac_fabric_target)
      message(FATAL_ERROR
        "qvac_addon_add_fuzz_target(${target} LINK_FABRIC): call "
        "qvac_addon_use_fabric() first to set qvac_fabric_target")
    endif()
    target_link_libraries(${target} PRIVATE
      qvac-fabric::headers ${qvac_fabric_target}_module)
    qvac_addon_stage_fabric_for_test(${target} ${qvac_fabric_target})
  endif()

  include(GoogleTest)
  add_test(NAME ${target} COMMAND ${target})
  set_tests_properties(${target} PROPERTIES TIMEOUT 600)

  # Pin the sanitizer posture on the test itself instead of inheriting whatever
  # the invoking shell carries: ASan replaces its defaults with ASAN_OPTIONS
  # wholesale, so a value left over from an addon-test session would silently
  # turn LeakSanitizer off here. A fabric-linked target has to run relaxed (the
  # static-libstdc++ boundary trips alloc/dealloc-mismatch and fabric's
  # long-lived globals look like leaks); everything else runs at full strength.
  # Mirrors scripts/run-cpp-fuzz.js and scripts/run-cpp-tests.js.
  if(NOT WIN32)
    if(_QAFZ_LINK_FABRIC)
      set(_qafz_asan_options "alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1")
    else()
      set(_qafz_asan_options "detect_leaks=1:abort_on_error=1")
    endif()
    set_tests_properties(${target} PROPERTIES
      ENVIRONMENT "ASAN_OPTIONS=${_qafz_asan_options}")
  endif()
endfunction()
