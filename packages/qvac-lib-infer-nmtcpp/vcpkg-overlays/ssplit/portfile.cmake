vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO browsermt/ssplit-cpp
  REF a311f9865ade34db1e8e080e6cc146f55dafb067
  SHA512 ae841e320654169ae7cf30e9f5f333d16e83938ff1c306d7abc73c83fd1cf72bd5df1064e1a3acab996527dadc23cc48acb854ba60eb61a1425c896bc8750d6b
  PATCHES
    ssplit-simple-install-rules.patch
    remove_hardcode_release_build_type.patch
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
  -DSSPLIT_COMPILE_LIBRARY_ONLY=ON
)

vcpkg_cmake_build()
vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
  PACKAGE_NAME ssplit
)

vcpkg_copy_pdbs()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE.md")


