# Thin wrapper port: forwards the system-installed ROCm/HIP CMake package configs
# (hip, rocblas, hipblas and their transitive deps) into the vcpkg tree so a
# consumer (qvac-fabric's hip-backend feature) can find_package(hip) under
# vcpkg's find-root scoping. ROCm itself is NOT built here — it is a large,
# system-installed SDK located via the ROCM_PATH env var.
#
# DETERMINISTIC: the hip-backend feature requires a ROCm SDK. If none is found
# this port errors out rather than installing empty — a host-dependent "skip"
# would let the vcpkg binary cache conflate a no-HIP build with a real HIP build
# (identical ABI). Don't request hip-backend on a host without ROCm. The RUNTIME
# fail-safe (Vulkan/CPU fallback when the HIP module/GPU is absent) is unaffected.
set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
set(VCPKG_POLICY_EMPTY_PACKAGE enabled)

set(_ROCM "")
if(DEFINED ENV{ROCM_PATH} AND EXISTS "$ENV{ROCM_PATH}/lib/cmake/hip/hip-config.cmake")
  file(TO_CMAKE_PATH "$ENV{ROCM_PATH}" _ROCM)
elseif(EXISTS "/opt/rocm/lib/cmake/hip/hip-config.cmake")
  set(_ROCM "/opt/rocm")
endif()

if(_ROCM STREQUAL "")
  message(FATAL_ERROR
    "hip port: no ROCm SDK found — set ROCM_PATH to a ROCm/TheRock install "
    "(containing lib/cmake/hip/hip-config.cmake). The hip-backend feature is "
    "deterministic and requires ROCm at build time.")
else()
  message(STATUS "hip port: forwarding ROCm CMake configs from ${_ROCM}")
  # Forward every <pkg>-config.cmake under the ROCm cmake dir via include() so
  # the originals keep resolving their own roots from the real ROCm location,
  # while find_package(<pkg> CONFIG) resolves them under the vcpkg prefix.
  file(GLOB _dirs LIST_DIRECTORIES true "${_ROCM}/lib/cmake/*")
  foreach(_d ${_dirs})
    if(IS_DIRECTORY "${_d}")
      get_filename_component(_pkg "${_d}" NAME)
      file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/share/${_pkg}")
      foreach(_cfg "${_pkg}-config.cmake" "${_pkg}Config.cmake")
        if(EXISTS "${_d}/${_cfg}")
          # Relocatable: resolve ROCm via $ENV{ROCM_PATH} at the CONSUMER's
          # configure time, NOT the absolute build path. The binary cache would
          # otherwise bake this build runner's $RUNNER_TEMP path (e.g.
          # /opt/actions-runner-9/...) and break when the package is restored on
          # a different runner. Consumers always have ROCM_PATH set (the
          # require-ROCm gate enforces it).
          file(WRITE "${CURRENT_PACKAGES_DIR}/share/${_pkg}/${_cfg}"
            "include(\"\$ENV{ROCM_PATH}/lib/cmake/${_pkg}/${_cfg}\")\n")
        endif()
      endforeach()
      foreach(_v "${_pkg}-config-version.cmake" "${_pkg}ConfigVersion.cmake")
        if(EXISTS "${_d}/${_v}")
          file(COPY "${_d}/${_v}" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${_pkg}")
        endif()
      endforeach()
    endif()
  endforeach()
endif()

file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/copyright"
  "ROCm/HIP is a system-installed SDK (located via ROCM_PATH); see its license at the install prefix.\n")
