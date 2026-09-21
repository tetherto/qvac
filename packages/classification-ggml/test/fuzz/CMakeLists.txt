cmake_minimum_required(VERSION 3.25)

# Fuzz targets for classification-ggml. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# preprocessToTensor() is the classification addon's untrusted-input front door:
# arbitrary image bytes flow into magic-byte detection and the stb_image decode
# path. It touches no ggml/fabric state, so LINK_FABRIC is omitted and the
# target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(preprocess-fuzz
  SOURCES
    preprocess_fuzz.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ImagePreprocessor.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${STB_INCLUDE_DIRS}
)
