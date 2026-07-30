# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.2 from the main
# snapshot (tetherto/qvac @ 47eccb47f, the squash-merge of PR #3525) instead
# of the published registry version, to verify this addon builds unchanged
# against the 1.3.2 multi-job scheduler + JsAsyncTask teardown fix
# (backwards-compatibility check; same REF/SHA512 across every consumer
# addon on this branch). Bump REF/SHA512 (and the overlay port-version) when
# retargeting. To fall back to the registry version, remove this port
# directory and the "overlay-ports" entry in vcpkg-configuration.json.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF 47eccb47f36d20c7aba4cd8e5892f7fd9eae5718
  SHA512 794e7ffaf4e46a3fa9c8bd331669c386c1ffc40349086a9a281ea38d5d2ddf9cb876e0d313b4708729c42cda70b9827170a185058d783f2074113bec237bec31
  HEAD_REF main
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
