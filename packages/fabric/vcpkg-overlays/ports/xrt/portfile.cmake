# Thin wrapper port: forwards the system-installed XRT CMake package configs
# (xrt, aiebu) into the vcpkg tree so a consumer (qvac-fabric's xdna-backend
# feature) can find_package(xrt) under vcpkg's find-root scoping, and gives
# dependent portfiles XRT_ROOT and XRT_XCLBINUTIL (vcpkg-port-config.cmake).
# XRT itself is NOT built here: the runtime must be the system one, which
# matches the installed NPU driver plugin.
#
# DETERMINISTIC: requesting this port requires XRT. If none is found it errors
# out rather than installing empty, so the binary cache never holds a no-XRT
# package under the same ABI as a real one.
set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)

set(QVAC_XRT_MIN_VERSION 2.25)

include("${CMAKE_CURRENT_LIST_DIR}/xrt-root.cmake")

foreach(_file IN ITEMS share/cmake/XRT/xrt-config.cmake share/cmake/AIEBU/aiebu-config.cmake bin/xclbinutil)
  if(NOT EXISTS "${XRT_ROOT}/${_file}")
    message(FATAL_ERROR
      "xrt port: ${XRT_ROOT}/${_file} not found. Install XRT ${QVAC_XRT_MIN_VERSION} or newer, "
      "or set XILINX_XRT to its install root (source its setup.sh).")
  endif()
endforeach()

file(STRINGS "${XRT_ROOT}/share/cmake/XRT/xrt-config.cmake" _version_line REGEX "^set\\(XRT_VERSION ")
string(REGEX MATCH "[0-9]+\\.[0-9]+\\.[0-9]+" XRT_SYSTEM_VERSION "${_version_line}")
if(XRT_SYSTEM_VERSION VERSION_LESS QVAC_XRT_MIN_VERSION)
  message(FATAL_ERROR "xrt port: ${XRT_ROOT} is XRT ${XRT_SYSTEM_VERSION}; ${QVAC_XRT_MIN_VERSION} or newer is required")
endif()
message(STATUS "xrt port: forwarding XRT ${XRT_SYSTEM_VERSION} from ${XRT_ROOT}")

# The forwarders include the system configs, which resolve their own prefix
# from their location, so XRT's imported targets point into the real install.
foreach(_pair IN ITEMS "XRT;xrt" "AIEBU;aiebu")
  list(GET _pair 0 _dir)
  list(GET _pair 1 _pkg)
  set(_deps "")
  if(_pkg STREQUAL "xrt")
    # XRT's exported targets link AIEBU::aiebu_static and friends, but its
    # config never finds AIEBU.
    set(_deps "include(CMakeFindDependencyMacro)\nfind_dependency(AIEBU CONFIG)\n")
  endif()
  file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/share/${_pkg}")
  file(WRITE "${CURRENT_PACKAGES_DIR}/share/${_pkg}/${_pkg}-config.cmake" "\
include(\"\${CMAKE_CURRENT_LIST_DIR}/xrt-root.cmake\")
if(NOT EXISTS \"\${XRT_ROOT}/share/cmake/${_dir}/${_pkg}-config.cmake\")
  set(\${CMAKE_FIND_PACKAGE_NAME}_FOUND FALSE)
  set(\${CMAKE_FIND_PACKAGE_NAME}_NOT_FOUND_MESSAGE \"no XRT at \${XRT_ROOT}; set XILINX_XRT to its install root\")
  return()
endif()
${_deps}include(\"\${XRT_ROOT}/share/cmake/${_dir}/${_pkg}-config.cmake\")
")
  # The version file has to come from this host's XRT too, not the build host's.
  file(WRITE "${CURRENT_PACKAGES_DIR}/share/${_pkg}/${_pkg}-config-version.cmake" "\
include(\"\${CMAKE_CURRENT_LIST_DIR}/xrt-root.cmake\")
if(EXISTS \"\${XRT_ROOT}/share/cmake/${_dir}/${_pkg}-config-version.cmake\")
  include(\"\${XRT_ROOT}/share/cmake/${_dir}/${_pkg}-config-version.cmake\")
else()
  set(PACKAGE_VERSION \"none (no XRT at \${XRT_ROOT}; set XILINX_XRT to its install root)\")
  set(PACKAGE_VERSION_UNSUITABLE TRUE)
endif()
")
  configure_file("${CMAKE_CURRENT_LIST_DIR}/xrt-root.cmake" "${CURRENT_PACKAGES_DIR}/share/${_pkg}/xrt-root.cmake" COPYONLY)
endforeach()

file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/vcpkg-port-config.cmake" "\
include(\"\${CMAKE_CURRENT_LIST_DIR}/xrt-root.cmake\")
set(XRT_XCLBINUTIL \"\${XRT_ROOT}/bin/xclbinutil\")
")

file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/copyright"
  "XRT is a system-installed runtime (located via XILINX_XRT, default /opt/xilinx/xrt), licensed under Apache-2.0; see the license directory at its install prefix.\n")
