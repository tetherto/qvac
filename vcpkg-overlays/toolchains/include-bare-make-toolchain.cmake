# Resolve, include, and forward one bare-make platform file.
# The caller sets _qvac_bare_make_toolchain_name (for example linux-x64.cmake)
# and may set _qvac_bare_make_label for the status line.

if(NOT _qvac_bare_make_toolchain_name)
  message(FATAL_ERROR "qvac: _qvac_bare_make_toolchain_name is not set")
endif()
if(NOT _qvac_bare_make_label)
  set(_qvac_bare_make_label "qvac")
endif()

if(DEFINED ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE} AND EXISTS "$ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE}")
  set(_qvac_bare_make_toolchain "$ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE}")
else()
  find_program(_qvac_bare_make_bin bare-make)
  if(NOT _qvac_bare_make_bin)
    message(FATAL_ERROR
      "${_qvac_bare_make_label}: bare-make is not on PATH and QVAC_BARE_MAKE_TOOLCHAIN_FILE is unset")
  endif()
  file(REAL_PATH "${_qvac_bare_make_bin}" _qvac_bare_make_real)
  get_filename_component(_qvac_bare_make_root "${_qvac_bare_make_real}" DIRECTORY)
  # npm nests cmake-toolchains under a global bare-make
  # (`<prefix>/node_modules/bare-make/node_modules/cmake-toolchains`).
  # A local `npm install` hoists it next to the package
  # (`<project>/node_modules/cmake-toolchains`). The bin is bin.js in the
  # package root, or a .bin shim whose real path stays in node_modules/.bin.
  foreach(_qvac_bare_make_candidate IN ITEMS
      "${_qvac_bare_make_root}/node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../../cmake-toolchains/${_qvac_bare_make_toolchain_name}")
    if(EXISTS "${_qvac_bare_make_candidate}")
      file(REAL_PATH "${_qvac_bare_make_candidate}" _qvac_bare_make_toolchain)
      break()
    endif()
  endforeach()
  if(NOT _qvac_bare_make_toolchain)
    set(_qvac_bare_make_toolchain
      "${_qvac_bare_make_root}/node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}")
  endif()
endif()

if(NOT EXISTS "${_qvac_bare_make_toolchain}")
  message(FATAL_ERROR
    "${_qvac_bare_make_label}: bare-make toolchain not found: ${_qvac_bare_make_toolchain}")
endif()

set(QVAC_BARE_MAKE_TOOLCHAIN_FILE "${_qvac_bare_make_toolchain}" CACHE FILEPATH
  "bare-make toolchain forwarded to ExternalProject host tools" FORCE)
message(STATUS "${_qvac_bare_make_label}: using bare-make toolchain ${QVAC_BARE_MAKE_TOOLCHAIN_FILE}")

# bare-make's win32 toolchain asks `node` for the clang-cl path. On Windows,
# CMake's execute_process runs an npm .cmd shim through cmd.exe, and the
# shim's "%_prog%" line becomes a program named `"node"` (quotes included).
# Fill the tool cache from the llvm-runtime .exe files so that lookup is
# skipped. If a tool is missing, still force node.exe so the fallback spawn
# is not a .cmd.
if(_qvac_bare_make_toolchain_name MATCHES "^win32-(x64|arm64)\\.cmake$")
  set(_qvac_win_arch "${CMAKE_MATCH_1}")
  if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Windows")
    find_program(_qvac_node_exe NAMES node.exe)
    if(_qvac_node_exe)
      set(node "${_qvac_node_exe}" CACHE FILEPATH "node.exe used to resolve llvm-runtime" FORCE)
    endif()
  endif()

  # cmake-toolchains and the llvm-runtime packages are siblings under node_modules.
  get_filename_component(_qvac_llvm_modules "${_qvac_bare_make_toolchain}" DIRECTORY)
  get_filename_component(_qvac_llvm_modules "${_qvac_llvm_modules}" DIRECTORY)
  set(_qvac_clang_bin "${_qvac_llvm_modules}/llvm-runtime-clang-win32-${_qvac_win_arch}/bin")
  set(_qvac_lld_bin "${_qvac_llvm_modules}/llvm-runtime-lld-win32-${_qvac_win_arch}/bin")
  set(_qvac_resource_dir "${_qvac_llvm_modules}/llvm-runtime-resources-win32")

  foreach(_qvac_tool IN ITEMS
      clang-cl llvm-lib llvm-ml64 llvm-mt llvm-nm llvm-objdump
      llvm-ranlib llvm-rc llvm-strip llvm-symbolizer)
    if(EXISTS "${_qvac_clang_bin}/${_qvac_tool}.exe")
      set("${_qvac_tool}" "${_qvac_clang_bin}/${_qvac_tool}.exe"
        CACHE FILEPATH "llvm-runtime ${_qvac_tool}" FORCE)
    endif()
  endforeach()
  if(EXISTS "${_qvac_lld_bin}/lld-link.exe")
    set(lld-link "${_qvac_lld_bin}/lld-link.exe"
      CACHE FILEPATH "llvm-runtime lld-link" FORCE)
  endif()
  if(EXISTS "${_qvac_resource_dir}")
    set(llvm_resource_dir "${_qvac_resource_dir}"
      CACHE PATH "llvm-runtime resource directory" FORCE)
  endif()

  unset(_qvac_win_arch)
  unset(_qvac_node_exe)
  unset(_qvac_llvm_modules)
  unset(_qvac_clang_bin)
  unset(_qvac_lld_bin)
  unset(_qvac_resource_dir)
  unset(_qvac_tool)
endif()

include("${QVAC_BARE_MAKE_TOOLCHAIN_FILE}")

# CMAKE_LINKER_TYPE applies to every language enabled later. bare-make sets
# it to LLD, and CMake's HIP toolchain does not implement that linker type
# (enable_language(HIP) fails the ABI try_compile). Keep LLD on the host
# languages and leave HIP on the linker its own toolchain selects.
if(CMAKE_LINKER_TYPE)
  foreach(_qvac_lang IN ITEMS C CXX ASM)
    if(NOT CMAKE_${_qvac_lang}_LINKER_TYPE)
      set(CMAKE_${_qvac_lang}_LINKER_TYPE "${CMAKE_LINKER_TYPE}")
    endif()
  endforeach()
  unset(CMAKE_LINKER_TYPE)
  unset(CMAKE_LINKER_TYPE CACHE)
  unset(_qvac_lang)
endif()

# That include registers cmake-toolchains' ExternalProject hook, which
# forwards vcpkg.cmake. Drop it and forward the bare-make file instead.
if(CMAKE_PROJECT_INCLUDE)
  list(FILTER CMAKE_PROJECT_INCLUDE EXCLUDE REGEX "/external-project/forward-toolchain\\.cmake$")
endif()
list(APPEND CMAKE_PROJECT_INCLUDE "${CMAKE_CURRENT_LIST_DIR}/forward-bare-make-toolchain.cmake")
list(REMOVE_DUPLICATES CMAKE_PROJECT_INCLUDE)

unset(_qvac_bare_make_toolchain_name)
unset(_qvac_bare_make_toolchain)
unset(_qvac_bare_make_bin)
unset(_qvac_bare_make_real)
unset(_qvac_bare_make_root)
unset(_qvac_bare_make_candidate)
unset(_qvac_bare_make_label)
