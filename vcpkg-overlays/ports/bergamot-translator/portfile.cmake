vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-ext-bergamot-translator
  # 99ef81e = b6788a8 (port-enabled lineage with install rules / cmake
  # config) + removal of leftover debug stderr prints (same fix as
  # upstream main 28cdbe7, which is not yet port-buildable: the squash
  # in qvac-ext-bergamot-translator#4 dropped the install/export rules).
  REF 99ef81e
  SHA512 a7ebee8ac56c74c7054f08439d092e832e62873d2a5e01ca20d55b4070523ef5c4cc62569bd6c9466fb5b02d7e2ae4df3c7f6de060d9489f21cf0bcfed1cf8a6
  PATCHES
    remove_build_type_flag.patch
    drop-static-ltcg-flag.patch
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
)

vcpkg_cmake_build()
vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
  PACKAGE_NAME bergamot-translator
  CONFIG_PATH share/bergamot-translator
)

vcpkg_copy_pdbs()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
