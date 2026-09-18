cmake_minimum_required(VERSION 3.25)

# Fuzz targets for translation-nmtcpp. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# The GGML weight-header parsers (n_dims / length / name / count) are the
# addon's untrusted-input front door on load. They touch no ggml/fabric state,
# so LINK_FABRIC is omitted and the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(nmt-weight-header-fuzz
  SOURCES
    nmt_weight_header_fuzz.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_loader_parse.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${SENTENCEPIECE_INCLUDE_DIRS}
  LINK_LIBS
    qvac-fabric::headers
    ${SENTENCEPIECE_TARGET}
)
