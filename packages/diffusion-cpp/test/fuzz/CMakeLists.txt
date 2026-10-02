cmake_minimum_required(VERSION 3.25)

# Fuzz targets for diffusion-cpp. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# inspectVideoModelCapabilities() walks untrusted GGUF metadata (string
# lengths, kv/tensor counts) without loading stable-diffusion.cpp. No
# LINK_FABRIC, so the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(video-model-capabilities-fuzz
  SOURCES
    video_model_capabilities_fuzz.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/utils/VideoModelCapabilities.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
)
