cmake_minimum_required(VERSION 3.25)

option(ANDROID_STL "Android STL linkage" c++_shared)
option(MOBILE_DYNAMIC_LINK "Use dynamic linking for the fabric runtime on mobile" ON)

option(VK_PROFILING "Force vk performance logging in qvac-fabric" OFF)
if(VK_PROFILING)
  list(APPEND VCPKG_MANIFEST_FEATURES "vk-profiling")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" _pkg_json)
string(JSON _pkg_version GET "${_pkg_json}" "version")

project(qvac-fabric VERSION ${_pkg_version} LANGUAGES C CXX)

# Test-only AddressSanitizer build, enabled with QVAC_FABRIC_ASAN=1 (the same
# flag the overlay triplet uses to instrument the qvac-fabric dependency). Here we
# instrument the module itself and, crucially, link the *shared* libc++ instead
# of -static-libstdc++. A module-local static libc++ would provide its own
# operator new/delete and the symbols.map `local: *` rule would bind them
# internally, so allocations made inside fabric would bottom out at malloc and
# clash with the test executable's ASan operator delete. With the shared libc++
# those operators resolve to the ASan runtime the test exe provides, so
# cross-module allocations match and ASan sees the whole runtime.
set(QVAC_FABRIC_ASAN OFF)
if(DEFINED ENV{QVAC_FABRIC_ASAN} AND NOT "$ENV{QVAC_FABRIC_ASAN}" STREQUAL "0")
  set(QVAC_FABRIC_ASAN ON)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  if(QVAC_FABRIC_ASAN)
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
    add_link_options(-stdlib=libc++ -fsanitize=address)
  else()
    add_link_options(-stdlib=libc++ -static-libstdc++)
  endif()
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# llama-targets.cmake transitively requires OpenSSL::SSL via cpp-httplib's
# IMPORTED interface. Make OpenSSL discoverable before find_package(llama) so
# the target chain resolves on local builds.
find_package(OpenSSL)
find_package(llama CONFIG REQUIRED)
find_package(ggml CONFIG REQUIRED)

# --- ggml backends -----------------------------------------------------------
# When ggml backends are built as separate shared libraries (e.g. Android, or a
# GGML_BACKEND_DL build) they are loaded at runtime via
# ggml_backend_load_all_from_path(). Stage those next to the shared module so
# they ship with @qvac/fabric and resolve their ggml_* references against this
# single loaded runtime (exported via symbols.map).
#
# On desktop with static vcpkg linkage the backends are static archives that get
# linked directly into qvac__fabric.bare and self-register via static
# initializers, so there is nothing to stage (and we must not ship the .a files).
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if(TARGET ggml::${_backend})
      get_target_property(_backend_type ggml::${_backend} TYPE)
      if(_backend_type STREQUAL "SHARED_LIBRARY")
        list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
      endif()
    endif()
  endforeach()
endif()

add_bare_module(qvac-fabric EXPORTS ${BACKEND_DL_LIBS})

target_sources(${qvac-fabric} PRIVATE addon/binding.cpp)

# Force-include the full llama / common / mtmd object code into the shared
# module so the entire public API is present (the carrier addon itself does not
# reference these symbols). The symbol map then controls what is exported.
target_link_libraries(
  ${qvac-fabric}
  PRIVATE
    "$<LINK_LIBRARY:WHOLE_ARCHIVE,llama::llama>"
    "$<LINK_LIBRARY:WHOLE_ARCHIVE,llama::common>"
    "$<LINK_LIBRARY:WHOLE_ARCHIVE,llama::mtmd>"
)

# build_info is a small separate static library defining the LLAMA_BUILD_NUMBER
# / LLAMA_COMMIT globals that libcommon references; whole-archive it so those
# symbols are present and can be exported.
if(TARGET llama::build_info)
  target_link_libraries(${qvac-fabric}
    PRIVATE "$<LINK_LIBRARY:WHOLE_ARCHIVE,llama::build_info>")
endif()

# Override install_name so that consumers using @loader_path rpath can resolve
# this library as a companion dependency (cmake-bare sets INSTALL_NAME_DIR ""
# which produces a bare filename install_name that dyld cannot resolve via rpath).
if(APPLE)
  set_target_properties(${qvac-fabric}_module PROPERTIES
    INSTALL_NAME_DIR "@rpath"
    BUILD_WITH_INSTALL_NAME_DIR ON)
endif()

# Symbol visibility: export the llama / ggml / common runtime surface plus the
# bare/napi entry points; hide everything else.
if(UNIX AND NOT APPLE)
  target_link_options(${qvac-fabric}_module PRIVATE
    -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map)
elseif(APPLE)
  target_link_options(${qvac-fabric}_module PRIVATE
    -Wl,-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/exports.txt)
elseif(WIN32)
  # Consumers link against the import library generated for qvac__fabric.bare,
  # so the Windows module must export the llama/ggml/common runtime surface.
  #
  # cmake-bare enables WINDOWS_EXPORT_ALL_SYMBOLS by default, but CMake only
  # scans this target's own object files for that, not the llama/common/mtmd
  # static libraries that carry the runtime API. There is also no MSVC-mode
  # "export everything" linker switch (-export-all-symbols only works in
  # lld-link's MinGW mode, which abandons the MSVC CRT/import libraries).
  #
  # Instead, generate a module-definition file by scanning the static archives
  # for the same symbol prefixes the ELF/Mach-O builds export, and feed it via
  # /DEF. The export entries double as references that pull the matching members
  # out of the archives, so the listed symbols are always present in the image.
  find_program(FABRIC_NM NAMES llvm-nm nm)
  if(NOT FABRIC_NM)
    set(FABRIC_NM "${CMAKE_NM}")
  endif()
  if(NOT FABRIC_NM)
    message(FATAL_ERROR "llvm-nm not found; required to generate the qvac-fabric Windows export def")
  endif()

  set(_fabric_export_libs
    "$<TARGET_FILE:llama::llama>"
    "$<TARGET_FILE:llama::common>"
    "$<TARGET_FILE:llama::mtmd>"
    "$<TARGET_FILE:ggml::ggml>"
    "$<TARGET_FILE:ggml::ggml-base>")
  # build_info carries the LLAMA_BUILD_NUMBER / LLAMA_COMMIT data globals. Scan
  # it only when it is a real archive; the vcpkg export ships it as an INTERFACE
  # (or OBJECT) target with no TARGET_FILE, in which case those objects are
  # merged into common.lib and the symbols are picked up from there. These data
  # globals are not exported from the runtime at all: bare delay-loads sibling
  # .bare modules on Windows and delay-loading cannot resolve data imports, so
  # consumers define module-local copies instead (see windows_fabric_data.cpp).
  if(TARGET llama::build_info)
    get_target_property(_fabric_build_info_type llama::build_info TYPE)
    if(NOT _fabric_build_info_type STREQUAL "OBJECT_LIBRARY"
       AND NOT _fabric_build_info_type STREQUAL "INTERFACE_LIBRARY")
      list(APPEND _fabric_export_libs "$<TARGET_FILE:llama::build_info>")
    endif()
  endif()

  set(_fabric_def "${CMAKE_CURRENT_BINARY_DIR}/qvac-fabric-exports.def")
  add_custom_command(
    OUTPUT "${_fabric_def}"
    COMMAND "${CMAKE_COMMAND}"
      "-DNM=${FABRIC_NM}"
      "-DOUTPUT=${_fabric_def}"
      "-DINPUTS=$<JOIN:${_fabric_export_libs},|>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/generate-windows-def.cmake"
    DEPENDS
      ${_fabric_export_libs}
      "${CMAKE_CURRENT_SOURCE_DIR}/cmake/generate-windows-def.cmake"
    VERBATIM
    COMMENT "Generating qvac-fabric Windows export def")
  add_custom_target(qvac-fabric-windows-def DEPENDS "${_fabric_def}")
  add_dependencies(${qvac-fabric}_module qvac-fabric-windows-def)

  # Replace CMake's per-target symbol scan with our archive-wide def.
  set_target_properties(${qvac-fabric}_module PROPERTIES
    WINDOWS_EXPORT_ALL_SYMBOLS OFF)
  # The main bare module uses symbol-based registration (cmake-bare defines
  # BARE_MODULE_NAME without BARE_MODULE_REGISTER_CONSTRUCTOR), so the bare
  # runtime locates the module by resolving these exported entry points by name.
  # WINDOWS_EXPORT_ALL_SYMBOLS normally exports them; since we disable it in
  # favour of the generated def, export them explicitly here. The "v0" suffix is
  # the bare module ABI version (BARE_MODULE_VERSION in bare/module.h).
  target_link_options(${qvac-fabric}_module PRIVATE
    "/DEF:${_fabric_def}"
    "/EXPORT:bare_get_module_name_v0"
    "/EXPORT:bare_register_module_v0")
endif()

# Strip the .bare module (keep dynamic symbols required for export). Skip when
# building the ASan test runtime so fabric frames keep their symbols in reports.
if(CMAKE_STRIP AND NOT WIN32 AND NOT QVAC_FABRIC_ASAN)
  if(APPLE)
    set(_strip_flags -x)
  else()
    set(_strip_flags --strip-unneeded)
  endif()
  add_custom_command(
    TARGET ${qvac-fabric}_module POST_BUILD
    COMMAND ${CMAKE_STRIP} ${_strip_flags} $<TARGET_FILE:${qvac-fabric}_module>
    COMMENT "Stripping ${qvac-fabric}_module")
endif()

# --- Export headers and cmake config for consumer addons ---------------------
# Headers ship with a nested layout: ggml*.h / gguf.h live at include/, while
# llama.h, llama-cpp.h, common/*.h and mtmd/*.h live under include/llama/.
# Expose both roots so consumers can use <ggml.h>, <llama.h> and <common/...>.
add_library(qvac-fabric-headers INTERFACE)
set_target_properties(qvac-fabric-headers PROPERTIES EXPORT_NAME headers)
target_include_directories(qvac-fabric-headers INTERFACE
  $<INSTALL_INTERFACE:include>
  $<INSTALL_INTERFACE:include/llama>)

# --- Installs ----------------------------------------------------------------
# Ship the llama / ggml / common / mtmd / gguf public headers from the vcpkg
# install tree. Exclude tooling headers that are not part of the runtime API.
install(DIRECTORY ${VCPKG_INSTALLED_PATH}/include/ DESTINATION include
  PATTERN "lint-cpp" EXCLUDE
  PATTERN "gtest" EXCLUDE
  PATTERN "gmock" EXCLUDE)

# Mobile: also install static libs and cmake configs for static linking.
if(ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS"))
  install(DIRECTORY ${VCPKG_INSTALLED_PATH}/lib/ DESTINATION lib
    FILES_MATCHING PATTERN "*.a" PATTERN "*.lib"
    PATTERN "pkgconfig" EXCLUDE)

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
    PATTERN "lint-cpp" EXCLUDE
    PATTERN "gtest" EXCLUDE
    PATTERN "pkgconfig" EXCLUDE
    PATTERN "vcpkg-cmake" EXCLUDE
    PATTERN "vcpkg-cmake-config" EXCLUDE
    PATTERN "vcpkg.spdx.json" EXCLUDE
    PATTERN "vcpkg_abi_info.txt" EXCLUDE
    PATTERN "copyright" EXCLUDE)
endif()

# --- qvac-fabric cmake package config ----------------------------------------
install(TARGETS qvac-fabric-headers EXPORT qvac-fabricTargets)
install(EXPORT qvac-fabricTargets NAMESPACE qvac-fabric:: DESTINATION share/qvac-fabric/cmake)

include(CMakePackageConfigHelpers)
configure_package_config_file(
  cmake/qvac-fabricConfig.cmake.in
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-fabricConfig.cmake
  INSTALL_DESTINATION share/qvac-fabric/cmake)
write_basic_package_version_file(
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-fabricConfigVersion.cmake
  VERSION ${PROJECT_VERSION} COMPATIBILITY SameMajorVersion)
install(FILES
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-fabricConfig.cmake
  ${CMAKE_CURRENT_BINARY_DIR}/qvac-fabricConfigVersion.cmake
  DESTINATION share/qvac-fabric/cmake)

# --- Platform-specific -------------------------------------------------------
if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${qvac-fabric} PRIVATE ${Vulkan_LIBRARY} log)
endif()

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
  target_compile_options(${qvac-fabric} PRIVATE "/utf-8")
  target_link_libraries(${qvac-fabric} PRIVATE msvcrt.lib)
endif()
