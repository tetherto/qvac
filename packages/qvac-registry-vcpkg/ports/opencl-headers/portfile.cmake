vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO KhronosGroup/OpenCL-Headers
  REF "v${VERSION}"
  SHA512 9d2ed2a8346bc3f967989091d8cc36148ffe5ff13fe30e12354cc8321c09328bbe23e74817526b99002729c884438a3b1834e175a271f6d36e8341fd86fc1ad5
  HEAD_REF main
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
)

vcpkg_cmake_install()

file(REMOVE_RECURSE
  "${CURRENT_PACKAGES_DIR}/debug")

vcpkg_fixup_pkgconfig()

vcpkg_install_copyright(FILE_LIST ${SOURCE_PATH}/LICENSE)
