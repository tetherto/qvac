cmake_minimum_required(VERSION 3.25)

# Fuzz targets for model-fit. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake.

# parseInteger / canonicalKey are header-only parsers over attacker-controlled
# llama config strings. They touch no ggml/fabric state, so LINK_FABRIC is
# omitted and the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(model-fit-config-parse-fuzz
  SOURCES
    config_parse_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
)
