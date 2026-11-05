cmake_minimum_required(VERSION 3.25)

# Fuzz targets for ocr-ggml. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake.

# decodeOrWrapImage is the addon's untrusted-input front door: encoded JPEG/PNG
# bytes or a raw bitmap with attacker-controlled width/height/bpp. OpenCV is
# required; ggml/fabric is not, so LINK_FABRIC is omitted and the target keeps
# full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(ocr-decode-image-fuzz
  SOURCES
    decode_image_fuzz.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/DecodeImage.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface
    ${OpenCV_INCLUDE_DIRS}
  LINK_LIBS
    ${OpenCV_LIBS}
)
