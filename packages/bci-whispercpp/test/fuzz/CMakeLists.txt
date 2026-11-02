cmake_minimum_required(VERSION 3.25)

# Fuzz targets for bci-whispercpp. Built only under -DBUILD_FUZZING=ON.
# See docs/architecture/ADDON-FUZZING.md and cmake/qvac-addon/qvac-addon.cmake
# (qvac_addon_add_fuzz_target).

# readNeuralFeatures() is the n_dims analogue: untrusted uint32 timesteps *
# channels * sizeof(float) must not wrap before the truncated-buffer check.
# Header-only, no whisper/fabric, so LINK_FABRIC is omitted and the target
# keeps full ASan + LeakSanitizer.
qvac_addon_add_fuzz_target(neural-signal-fuzz
  SOURCES
    neural_signal_fuzz.cpp
  INCLUDE_DIRS
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)
