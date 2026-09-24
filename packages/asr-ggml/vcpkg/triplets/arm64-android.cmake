include("${CMAKE_CURRENT_LIST_DIR}/../../../../vcpkg-overlays/triplets/arm64-android.cmake")

# Tracked passthrough: SDK selection changes the binary-cache ABI. These
# variables are consumed only when ASR_HEXAGON enables the optional feature.
list(APPEND VCPKG_ENV_PASSTHROUGH HEXAGON_SDK_ROOT HEXAGON_TOOLS_ROOT)
