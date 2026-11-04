# Resolve, include, and forward one bare-make platform file.
# The caller sets _qvac_bare_make_toolchain_name (for example linux-x64.cmake).

if(DEFINED ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE})
  set(_qvac_bare_make_toolchain "$ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE}")
else()
  find_program(_qvac_bare_make_bin bare-make)
  if(NOT _qvac_bare_make_bin)
    message(FATAL_ERROR "qvac: bare-make is not on PATH and QVAC_BARE_MAKE_TOOLCHAIN_FILE is unset")
  endif()
  file(REAL_PATH "${_qvac_bare_make_bin}" _qvac_bare_make_real)
  get_filename_component(_qvac_bare_make_root "${_qvac_bare_make_real}" DIRECTORY)
  # A global npm install nests cmake-toolchains under bare-make. A local
  # install hoists it next to bare-make (or next to node_modules/.bin when the
  # bin is a Windows .cmd shim).
  foreach(_qvac_bare_make_candidate IN ITEMS
      "${_qvac_bare_make_root}/node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../cmake-toolchains/${_qvac_bare_make_toolchain_name}")
    if(EXISTS "${_qvac_bare_make_candidate}")
      file(REAL_PATH "${_qvac_bare_make_candidate}" _qvac_bare_make_toolchain)
      break()
    endif()
  endforeach()
endif()

if(NOT EXISTS "${_qvac_bare_make_toolchain}")
  message(FATAL_ERROR "qvac: bare-make toolchain ${_qvac_bare_make_toolchain_name} not found")
endif()

set(QVAC_BARE_MAKE_TOOLCHAIN_FILE "${_qvac_bare_make_toolchain}" CACHE FILEPATH
  "bare-make toolchain forwarded to ExternalProject host tools" FORCE)

# Warn when the resolved toolchain is not the one CI locks, which is usually a
# stale global bare-make ahead of .github/bare-toolchain on PATH. The packages
# sit beside cmake-toolchains in both a local and a global install; a global
# bare-make is the directory above.
set(_qvac_bare_lockfile "${CMAKE_CURRENT_LIST_DIR}/../../.github/bare-toolchain/package-lock.json")
get_property(_qvac_bare_lock_checked GLOBAL PROPERTY _QVAC_BARE_LOCK_CHECKED)
get_property(_qvac_bare_in_try_compile GLOBAL PROPERTY IN_TRY_COMPILE)
if(EXISTS "${_qvac_bare_lockfile}" AND NOT _qvac_bare_lock_checked AND NOT _qvac_bare_in_try_compile)
  set_property(GLOBAL PROPERTY _QVAC_BARE_LOCK_CHECKED TRUE)
  file(READ "${_qvac_bare_lockfile}" _qvac_bare_lock)
  get_filename_component(_qvac_bare_modules "${QVAC_BARE_MAKE_TOOLCHAIN_FILE}" DIRECTORY)
  get_filename_component(_qvac_bare_modules "${_qvac_bare_modules}" DIRECTORY)
  foreach(_qvac_bare_package IN ITEMS bare-make cmake-toolchains llvm-runtime)
    string(JSON _qvac_bare_locked ERROR_VARIABLE _qvac_bare_error
      GET "${_qvac_bare_lock}" packages "node_modules/${_qvac_bare_package}" version)
    unset(_qvac_bare_installed)
    foreach(_qvac_bare_manifest IN ITEMS
        "${_qvac_bare_modules}/${_qvac_bare_package}/package.json"
        "${_qvac_bare_modules}/../package.json")
      if(EXISTS "${_qvac_bare_manifest}")
        file(READ "${_qvac_bare_manifest}" _qvac_bare_json)
        string(JSON _qvac_bare_name ERROR_VARIABLE _qvac_bare_error GET "${_qvac_bare_json}" name)
        if(_qvac_bare_name STREQUAL _qvac_bare_package)
          string(JSON _qvac_bare_installed ERROR_VARIABLE _qvac_bare_error GET "${_qvac_bare_json}" version)
          break()
        endif()
      endif()
    endforeach()
    if(_qvac_bare_installed AND _qvac_bare_locked AND NOT _qvac_bare_installed STREQUAL _qvac_bare_locked)
      message(WARNING "qvac: building with ${_qvac_bare_package} ${_qvac_bare_installed}, but CI locks "
        "${_qvac_bare_locked}. Run node .github/bare-toolchain/install.mjs and put its node_modules/.bin "
        "first on PATH to build what CI builds.")
    endif()
  endforeach()
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
unset(_qvac_bare_lockfile)
unset(_qvac_bare_lock_checked)
unset(_qvac_bare_in_try_compile)
unset(_qvac_bare_lock)
unset(_qvac_bare_modules)
unset(_qvac_bare_package)
unset(_qvac_bare_locked)
unset(_qvac_bare_installed)
unset(_qvac_bare_manifest)
unset(_qvac_bare_json)
unset(_qvac_bare_name)
unset(_qvac_bare_error)
