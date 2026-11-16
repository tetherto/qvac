include_guard(GLOBAL)

# The version of the qvac-fabric vcpkg port installed under `installed_root`
# (a vcpkg_installed/<triplet> directory), read from the SPDX document vcpkg
# writes for every port it installs, e.g. "11739.0.0#1".
#
# Fabric's build records the port its runtime is built from in its CMake
# config as QVAC_FABRIC_PORT_VERSION. An addon that links code from its own
# build of the port (@qvac/decision-ggml's server-context) reads its port the
# same way and compares the two: qvac_addon_link_fabric_server_context() in
# cmake/qvac-addon.
function(qvac_fabric_installed_port_version installed_root result)
  set(_spdx "${installed_root}/share/qvac-fabric/vcpkg.spdx.json")
  if(NOT EXISTS "${_spdx}")
    message(FATAL_ERROR
      "qvac-fabric: ${_spdx} not found; cannot tell which qvac-fabric port is installed.")
  endif()
  file(READ "${_spdx}" _json)
  string(JSON _count LENGTH "${_json}" packages)
  math(EXPR _last "${_count} - 1")
  foreach(_i RANGE ${_last})
    string(JSON _name GET "${_json}" packages ${_i} name)
    if(_name STREQUAL "qvac-fabric")
      string(JSON _version GET "${_json}" packages ${_i} versionInfo)
      set(${result} "${_version}" PARENT_SCOPE)
      return()
    endif()
  endforeach()
  message(FATAL_ERROR "qvac-fabric: ${_spdx} names no qvac-fabric package.")
endfunction()
