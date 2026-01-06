vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO KhronosGroup/OpenCL-ICD-Loader
  REF "v${VERSION}"
  SHA512 29043eff21076440046314edf62bb488b7e4e17d9fbdac4c3727d8e2523c0c8fbf89ee7fcf762528af761ddbcb4be24e5f062ffa82f778401d6365faa35344a8
)

vcpkg_check_linkage(ONLY_DYNAMIC_LIBRARY)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
)

vcpkg_cmake_install()

set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

vcpkg_fixup_pkgconfig()

vcpkg_install_copyright(FILE_LIST ${SOURCE_PATH}/LICENSE)
