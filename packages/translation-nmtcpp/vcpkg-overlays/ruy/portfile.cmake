set(VERSION "2d950b3bfa7ebfbe7a97ecb44b1cc4da5ac1d6f0") # Replace with a pinned commit or tag for reproducible builds

vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO google/ruy
  REF ${VERSION}
  # IMPORTANT: Replace the placeholder below with the correct SHA512 of the downloaded source archive.
  # You can get this by running: vcpkg install --overlay-ports=... --head ruy (or by computing the hash)
  SHA512 e7208485610f0022885dc172af2b232c190de51303d79d2b0107080855f06cad18be7bd3062d8cdad8c43524fec2b350bd8dd4e16e485d232dafaddabf91ca34
  HEAD_REF master
  PATCHES
    0001-add-basic-install-rules.patch
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DRUY_MINIMAL_BUILD=ON
    -DRUY_PROFILER=OFF
    -DBUILD_SHARED_LIBS=OFF
)

vcpkg_cmake_build()
vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
  PACKAGE_NAME ruy
  CONFIG_PATH share/ruy
)

# Overwrite config to reference installed targets file via a relocatable path.
# Write the literal ${CMAKE_CURRENT_LIST_DIR} so it expands when consumed (not now).
set(_RCLD "\${CMAKE_CURRENT_LIST_DIR}")
file(WRITE "${CURRENT_PACKAGES_DIR}/share/ruy/ruyConfig.cmake"
"include(CMakeFindDependencyMacro)\nfind_dependency(cpuinfo CONFIG)\ninclude(\"${_RCLD}/ruyTargets.cmake\")\n")

# If the export file was not produced upstream, create a placeholder to satisfy include().
if(NOT EXISTS "${CURRENT_PACKAGES_DIR}/share/ruy/ruyTargets.cmake")
  file(WRITE "${CURRENT_PACKAGES_DIR}/share/ruy/ruyTargets.cmake"
    "# ruyTargets.cmake placeholder written by overlay port.\n")
endif()

vcpkg_fixup_pkgconfig()
vcpkg_copy_pdbs()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")


