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
  REF e3d0cc4cad00c904f8100e1695aee9109a70f6fb
  SHA512 574b1c57876454bc8155355f00fcd9bb892737518f3b3b90230509ca41541090ff50099bf8c8bcb38a603ec67e70f4a7a79dff3253194181741331086c233997
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
