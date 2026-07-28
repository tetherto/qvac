# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.1 from the addon-cpp
# snapshot branch (tetherto/qvac @ continuousBatchingMultiJobAddonCppFixup) instead
# of the published registry version, to verify this addon builds unchanged
# against the 1.3.1 multi-job scheduler (backwards-compatibility check; same
# REF/SHA512 as the llm-llamacpp portfile_dev overlay). Bump REF/SHA512 (and
# the overlay port-version) when that branch moves. To fall back to the
# registry version, remove this port directory and the "overlay-ports" entry
# in vcpkg-configuration.json.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF 3809d763b12cfb2c32683b69caca4c22f55b7b81
  SHA512 6a72fad5032797f360e7e39c3d5d9d47e5c32b44b1fb793a0bf906d0c90f59ea91e92908d1f0c47277189a4343d30af5af3f051792974cd919a358b8ce18d0ab
  HEAD_REF continuousBatchingMultiJobAddonCppFixup
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    tests BUILD_TESTING
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}/packages/inference-addon-cpp"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

file(
  INSTALL "${SOURCE_PATH}/packages/inference-addon-cpp/LICENSE"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}"
  RENAME copyright
)
