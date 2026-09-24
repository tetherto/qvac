cmake_minimum_required(VERSION 3.25)

# Fuzz targets for asr-ggml. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# decodeS16lePcm() is the Parakeet untrusted-audio front door: arbitrary PCM
# bytes become float32 samples. Header-only, no engine/fabric, so LINK_FABRIC
# is omitted and the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(pcm-decode-fuzz
  SOURCES
    pcm_decode_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
)
