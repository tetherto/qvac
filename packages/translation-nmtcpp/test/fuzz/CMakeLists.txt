cmake_minimum_required(VERSION 3.25)

# Fuzz targets for translation-nmtcpp. Built only under -DBUILD_FUZZING=ON
# against test/fuzz/vcpkg.json, never the package-root manifest. See
# docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# The GGML weight-header parsers (n_dims / length / name / count) are the
# addon's untrusted-input front door on load. They touch no ggml/fabric state
# and no sentencepiece, so LINK_FABRIC is omitted and the target keeps full
# ASan + LeakSanitizer. ggml.h comes from the npm @qvac/fabric headers.
qvac_addon_add_fuzz_target(nmt-weight-header-fuzz
  SOURCES
    nmt_weight_header_fuzz.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_loader_parse.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
  LINK_LIBS
    qvac-fabric::headers
)
