message(STATUS ">>> Building custom onnxruntime port with platform-specific patches")

# Common patches
set(ONNXRUNTIME_PATCHES
  "01-replace-deprecated-gsl-byte.patch"
  "02-add-static-lib.patch"
  "03-fix-dll.patch"
  "04-fix-android-binary-size.patch"
  "05-add-dependencies-to-config.patch"
  "06-fix-array-bounds-issue-ios-sim.patch"
)

# Add extra patches only for Windows builds
if("dml-ep" IN_LIST FEATURES)
  message(STATUS "Applying Windows-specific patches (DirectML)...")
  list(APPEND ONNXRUNTIME_PATCHES
    "07-fix-dml-export.patch"
  )
endif()

# Add extra patches only for Apple builds
if(VCPKG_CMAKE_SYSTEM_NAME STREQUAL "Darwin" OR VCPKG_CMAKE_SYSTEM_NAME STREQUAL "iOS")
  message(STATUS "Applying Apple-specific patches (CoreML)...")
  list(APPEND ONNXRUNTIME_PATCHES
    "07-fix-coreml-export.patch"
    "08-fix-coreml-proto-include.patch"
  )
endif()

# Add extra patches only for Android builds
if(VCPKG_CMAKE_SYSTEM_NAME STREQUAL "Android" AND NOT "minimal-build" IN_LIST FEATURES)
  message(STATUS "Applying Android-specific patches (NNAPI)...")
  list(APPEND ONNXRUNTIME_PATCHES
    "07-fix-nnapi-export.patch"
  ) 
endif()

if("minimal-build" IN_LIST FEATURES)
  list(APPEND ONNXRUNTIME_PATCHES
    "09-fix-minimal-build-onnx-onnx-proto-issue.patch"
  )
endif()

vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO microsoft/onnxruntime
  REF "v${VERSION}"
  SHA512 028a7f48f41d2e8a453aae25ebc4cd769db389401937928b7d452fab5f8d7af8cb63eb4150daf79589845528f0e4c3bdfefa27af70d3630398990c9e8b85387b
  PATCHES ${ONNXRUNTIME_PATCHES}
)

# Apple build options
set(APPLE_BUILD_OPTIONS "")
if("coreml-ep" IN_LIST FEATURES AND
   (VCPKG_CMAKE_SYSTEM_NAME STREQUAL "Darwin" OR VCPKG_CMAKE_SYSTEM_NAME STREQUAL "iOS"))
  message(STATUS "Pre-downloading coremltools for CoreML support...")

  vcpkg_download_distfile(COREMLTOOLS_ARCHIVE
    URLS "https://github.com/apple/coremltools/archive/refs/tags/7.1.zip"
    FILENAME "coremltools-7.1.zip"
    SHA512 c6645d0b48953fe4a7f3ffa34df35c40ddc764e76b9aa8ec1af282842f8346129df650514cb5bc6dde52ecb75750aac4ad159e5cfa6384146cfa72c75af77399
  )

  # Extract to the expected location for FetchContent
  set(DEPS_DIR "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/_deps")
  file(MAKE_DIRECTORY "${DEPS_DIR}")

  vcpkg_extract_source_archive_ex(
    OUT_SOURCE_PATH COREMLTOOLS_SOURCE_PATH
    ARCHIVE "${COREMLTOOLS_ARCHIVE}"
    WORKING_DIRECTORY "${DEPS_DIR}"
  )

  # Copy to the expected directory name
  set(COREMLTOOLS_DIR "${DEPS_DIR}/coremltools-src")
  file(REMOVE_RECURSE "${COREMLTOOLS_DIR}")
  file(COPY "${COREMLTOOLS_SOURCE_PATH}/" DESTINATION "${COREMLTOOLS_DIR}")

  # Verify proto files exist
  file(GLOB PROTO_FILES "${COREMLTOOLS_DIR}/mlmodel/format/*.proto")
  list(LENGTH PROTO_FILES PROTO_COUNT)
  message(STATUS "Found ${PROTO_COUNT} proto files in ${COREMLTOOLS_DIR}/mlmodel/format/")

  set(APPLE_BUILD_OPTIONS
    -Dcoremltools_SOURCE_DIR=${COREMLTOOLS_DIR}
    -Dcoremltools_POPULATED=TRUE
    -DFETCHCONTENT_FULLY_DISCONNECTED=OFF
  )
endif()

# Feature mapping
vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
      nnapi-ep onnxruntime_USE_NNAPI_BUILTIN
      coreml-ep onnxruntime_USE_COREML
      dml-ep onnxruntime_USE_DML
      minimal-build onnxruntime_MINIMAL_BUILD
      tests onnxruntime_BUILD_UNIT_TESTS
)

# Configure build
vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}/cmake"
  OPTIONS
    -Donnxruntime_USE_VCPKG=ON
    -Donnxruntime_BUILD_SHARED_LIB=ON
    -Donnxruntime_ENABLE_BITCODE=OFF
    -Donnxruntime_ENABLE_PYTHON=OFF
    -Donnxruntime_DISABLE_RTTI=OFF
    -Donnxruntime_DISABLE_EXCEPTIONS=OFF
    ${FEATURE_OPTIONS}
    ${APPLE_BUILD_OPTIONS}
)

vcpkg_cmake_install()

vcpkg_fixup_pkgconfig()

vcpkg_cmake_config_fixup(
  CONFIG_PATH lib/cmake/onnxruntime
)

# Cleanup
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")

# Install copyright
vcpkg_install_copyright(FILE_LIST
  "${SOURCE_PATH}/LICENSE"
  "${SOURCE_PATH}/ThirdPartyNotices.txt"
)
