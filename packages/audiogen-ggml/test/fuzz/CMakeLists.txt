cmake_minimum_required(VERSION 3.25)

# Fuzz targets for audiogen-ggml. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# parseInteger / parseFloat / checkedInteger / checkedFloat wrap
# attacker-controlled config values from the JS adapter. Header-only, no
# engine/fabric, so LINK_FABRIC is omitted and the target keeps full ASan +
# LeakSanitizer.
qvac_addon_add_fuzz_target(audiogen-config-parse-fuzz
  SOURCES
    audiogen_config_parse_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)
