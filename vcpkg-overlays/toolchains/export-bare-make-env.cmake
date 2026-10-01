# Include before project(). On Windows, vcpkg builds ports in a clean
# environment that drops PATH, so the triplet toolchain cannot find bare-make
# or node there. Export the toolchain the package configures with, and put
# node's directory on CMAKE_PROGRAM_PATH, which find_program() reads in ports,
# their nested projects, and try_compile. The Windows triplets pass both
# through with VCPKG_ENV_PASSTHROUGH_UNTRACKED.
include_guard(GLOBAL)

if(NOT CMAKE_HOST_WIN32)
  return()
endif()

# Without a downloaded cmake, vcpkg takes the first sufficient cmake on PATH.
# An npm .cmd shim (bare-make's cmake-runtime) passes the version check but
# then fails in the clean environment with '"node"' is not recognized.
if(NOT DEFINED ENV{VCPKG_FORCE_DOWNLOADED_BINARIES} AND NOT DEFINED ENV{VCPKG_FORCE_SYSTEM_BINARIES})
  set(ENV{VCPKG_FORCE_DOWNLOADED_BINARIES} 1)
endif()

if(NOT DEFINED ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE} AND VCPKG_CMAKE_TOOLCHAIN_FILE)
  set(ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE} "${VCPKG_CMAKE_TOOLCHAIN_FILE}")
endif()

find_program(QVAC_NODE_EXECUTABLE NAMES node.exe)
if(QVAC_NODE_EXECUTABLE)
  # Resolve version-manager shims (fnm per-shell links) that do not outlive
  # the shell that configured the package.
  file(REAL_PATH "${QVAC_NODE_EXECUTABLE}" _qvac_node_real)
  cmake_path(GET _qvac_node_real PARENT_PATH _qvac_node_dir)
  cmake_path(NATIVE_PATH _qvac_node_dir _qvac_node_dir)
  if("$ENV{CMAKE_PROGRAM_PATH}" STREQUAL "")
    set(ENV{CMAKE_PROGRAM_PATH} "${_qvac_node_dir}")
  else()
    set(ENV{CMAKE_PROGRAM_PATH} "${_qvac_node_dir};$ENV{CMAKE_PROGRAM_PATH}")
  endif()
  unset(_qvac_node_real)
  unset(_qvac_node_dir)
endif()
