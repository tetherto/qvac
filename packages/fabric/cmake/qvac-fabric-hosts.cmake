include_guard(GLOBAL)

# Maps a Bare host (bare_target()) to the suffix of the @qvac/fabric platform
# package that carries its runtime: @qvac/fabric-<suffix>. Every iOS host
# (device and both simulators) shares one package; every other host has its
# own. Keep in sync with the "#host-addon" imports map in package.json and
# SLICE_DEFINITIONS in scripts/ci/slice-platform-packages.mjs (the unit tests
# check all three).
function(qvac_fabric_platform_suffix host result)
  if(host MATCHES "^ios-")
    set(${result} "ios" PARENT_SCOPE)
  else()
    set(${result} "${host}" PARENT_SCOPE)
  endif()
endfunction()

function(qvac_fabric_platform_package host result)
  qvac_fabric_platform_suffix("${host}" _suffix)
  set(${result} "@qvac/fabric-${_suffix}" PARENT_SCOPE)
endfunction()

# The name the runtime module is built under for `host`: the mangled name of its
# platform package, which is what require.addon(), bare-pack and bare-link look
# for in that package's prebuilds/<host>/, and what consumers record as
# DT_NEEDED (qvac__fabric-<suffix>@<major>.bare).
function(qvac_fabric_module_name host result)
  qvac_fabric_platform_suffix("${host}" _suffix)
  set(${result} "qvac__fabric-${_suffix}" PARENT_SCOPE)
endfunction()
