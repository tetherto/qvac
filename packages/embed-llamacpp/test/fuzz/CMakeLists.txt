cmake_minimum_required(VERSION 3.25)

# Fuzz targets for embed-llamacpp. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake.

# parseMainGpu / preferredBackendTypeFromString are header-only parsers over
# attacker-controlled config strings. They touch no ggml/fabric state, so
# LINK_FABRIC is omitted and the target keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(embed-config-parse-fuzz
  SOURCES
    config_parse_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)
