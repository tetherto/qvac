cmake_minimum_required(VERSION 3.25)

# Fuzz targets for vla-ggml. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake.

# safetensors_lite is a header-only JSON-ish length-prefixed parser over
# untrusted model dumps. It touches no ggml/fabric state, so LINK_FABRIC is
# omitted and the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(safetensors-lite-fuzz
  SOURCES
    safetensors_lite_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
)
