cmake_minimum_required(VERSION 3.25)

# Fuzz targets for llm-llamacpp. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake.

# Stop-string matching and forLogMessage are header-only transforms over
# untrusted model/caller text. They touch no ggml/fabric state, so
# LINK_FABRIC is omitted and the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(llm-string-fuzz
  SOURCES
    string_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
)
