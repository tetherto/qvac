# parakeet-cpp: NVIDIA Parakeet ASR + Sortformer diarization in pure C++/ggml.
# Sourced from the parakeet-cpp/ subfolder of tetherto/qvac-ext-lib-whisper.cpp;
# consumes the ggml-speech port.
#
# Pinned at master ecac5bb7 (PR #85), layered on top of the 2e2f4d5 pin
# (PR #87: CPU repack of quantized encoder GEMM weights, q4_0/q8_0 ->
# interleaved 4x8/8x8 layouts, closing the CPU-side q4_0 speed penalty) and
# the previous df54e37 pin (TDT multi-layer LSTM state, PR #83). Runs the EOU
# RNN-T decoder as ggml graphs on GPU backends (Metal / CUDA / Vulkan):
# span-batched joint scoring 16 frames per launch, persistent LSTM/pred state
# and full-window enc-projection on device, on-device argmax, on-device <EOU>
# state reset. Scalar host decode stays for CPU and ggml-opencl. RTX 4000
# Vulkan RTF for EOU drops 0.0052 -> 0.0031 (decoder ~54 -> ~14.5 ms per 20 s
# file). Requires ggml-speech >= 2026-07-13 (qvac-ext-ggml PR #40): Vulkan
# row-wise shader OOB-write guards, without which the EOU encoder garbles the
# first utterance of any file longer than 512 encoder frames (~41 s) on
# Vulkan.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH WHISPER_CPP_SRC
    REPO tetherto/qvac-ext-lib-whisper.cpp
    REF 4dd6b2e82ef8f68e15a3c10c2f2e0b2351313ece
    SHA512 fedb5793c860ba688756e3ec1a7c816860581efeef78df5f4b72d96d9df7cc6a3d595e7959e6deb7e0ba663bbde6f3a5b073340186c8a55e573a53eda28ecb11
    HEAD_REF master
)

set(SOURCE_PATH "${WHISPER_CPP_SRC}/engines/parakeet")
if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "parakeet-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the parakeet-cpp/ "
        "subfolder layout in qvac-ext-lib-whisper.cpp may have changed.")
endif()

set(GGML_METAL  OFF)
set(GGML_VULKAN OFF)
set(GGML_CUDA   OFF)
set(GGML_OPENCL OFF)
if("metal" IN_LIST FEATURES)
    set(GGML_METAL ON)
endif()
if("vulkan" IN_LIST FEATURES)
    set(GGML_VULKAN ON)
endif()
if("cuda" IN_LIST FEATURES)
    set(GGML_CUDA ON)
endif()
if("opencl" IN_LIST FEATURES)
    set(GGML_OPENCL ON)
endif()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DPARAKEET_BUILD_LIBRARY=ON
        -DPARAKEET_BUILD_EXECUTABLES=OFF
        -DPARAKEET_BUILD_TESTS=OFF
        -DPARAKEET_BUILD_EXAMPLES=OFF
        -DPARAKEET_INSTALL=ON
        -DPARAKEET_USE_SYSTEM_GGML=ON
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_OPENMP=OFF
        -DPARAKEET_OPENMP=OFF
        -DGGML_CCACHE=OFF
        -DPARAKEET_CCACHE=OFF
        -DGGML_METAL=${GGML_METAL}
        -DGGML_VULKAN=${GGML_VULKAN}
        -DGGML_CUDA=${GGML_CUDA}
        -DGGML_OPENCL=${GGML_OPENCL}
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(PACKAGE_NAME parakeet-cpp CONFIG_PATH share/parakeet-cpp)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
