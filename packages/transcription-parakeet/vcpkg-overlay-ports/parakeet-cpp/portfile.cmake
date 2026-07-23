# parakeet-cpp: NVIDIA Parakeet ASR + Sortformer diarization in pure C++/ggml.
# Sourced from the engines/parakeet/ subfolder of tetherto/qvac-ext-lib-whisper.cpp;
# consumes the ggml-speech port.
#
# Long-audio memory fix: bound offline-transcription memory. transcribe_samples
# / transcribe_samples_stream previously ran the conformer encoder over the whole
# input in a single graph (O(T_enc^2) self-attention), OOMing on multi-hour files
# (~100 GB for a 90 min file, SIGKILL). This pin computes the mel once (global
# CMVN) and slides the encoder over it in overlapping windows, trimming the
# shared context at the interior seams; inputs that fit one window keep the
# bit-identical single-pass path. Requires ggml-speech >= 2026-07-15 (unchanged
# from the previous pin).
#
# Pinned at tetherto/qvac-ext-lib-whisper.cpp master 88b690c0 (PR #101), the
# merged long-form windowed-encoder change on the engines/parakeet layout.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH WHISPER_CPP_SRC
    REPO tetherto/qvac-ext-lib-whisper.cpp
    REF 88b690c051666a63d6f5494a68596c4e785468ef
    SHA512 a1adf1fc953e4c8210e120fc2859aece34a0c738407a346dadaa4bc1762b3f6f6f65ddaceb5ee6d470f56e209ae1d6f49a671cc844f3dfdd8c8a46bf53b426f0
    HEAD_REF master
)

set(SOURCE_PATH "${WHISPER_CPP_SRC}/engines/parakeet")
if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "parakeet-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the engines/parakeet/ "
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
