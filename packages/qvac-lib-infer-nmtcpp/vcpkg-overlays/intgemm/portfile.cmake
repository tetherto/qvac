vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO kpu/intgemm
  REF f7401513da71758dacce52fed1c7855549abee59
  SHA512 cd9d57fa9f00f47b9b51b5b1693f1fb432877b7e6c8df4e6692ddc0ae14134d3183adae4276865a705a726a190d0f31ab731107b3ab04fe031f1b526134bfd0b
  HEAD_REF master
  PATCHES
    intgemm-basic-install-rules.patch
    fix-intgemm-clang-cl.patch
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DINTGEMM_DONT_BUILD_TESTS=OFF
)

vcpkg_cmake_build()
vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
  PACKAGE_NAME intgemm
  CONFIG_PATH share/intgemm
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


