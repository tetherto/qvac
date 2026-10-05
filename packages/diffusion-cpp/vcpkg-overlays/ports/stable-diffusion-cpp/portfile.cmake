# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml (provided by the separate ggml overlay port, pinned
# from the same engine branch date).
#
# Installed artefacts:
#   include/stable-diffusion.h   (main C API)
#   lib/libstable-diffusion.a    (static library)
#   share/stable-diffusion-cpp/  (CMake package config)
#
# GPU backend selection is handled at runtime via ggml's backend registry;
# on Android and desktop Linux the GPU backends are dlopen'd modules
# (hybrid GGML_BACKEND_DL, see the ggml port).
#
# Pins tetherto/qvac-ext-stable-diffusion.cpp commit
# 107121df3ee9664cd47f80b19add495002d0232f from the 2026-08-11 line,
# including merged MiniMax-H3 and ConvRot support. Relative to the 2026-07-03
# line this brings the rebased upstream API: bool-returning
# generate_image()/upscale() with out-params, sd_cancel_generation(),
# ref_image_args replacing the per-field reference knobs, param residency via
# backend assignment specs (params_backend/max_vram strings) instead of the
# keep_*_on_cpu/offload_params_to_cpu booleans, and the SeFi/MiniT2I/hires/
# adetailer additions. The ABot-World session/scene C API is unchanged.
#
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 107121df3ee9664cd47f80b19add495002d0232f
    SHA512 f0e4b70f8005b45169c17cb9f097450d00a9f3d9acee046a31c085f1745ae9a8ebb6f5308f5cf260f7b4905932f5ea4fce2f0ccc73e23bbd67e3c1966888bd31
)

# Even under SD_USE_SYSTEM_GGML the sources reach into one ggml *internal*
# header (src/core/ggml_extend_backend.cpp includes "ggml/src/ggml-impl.h");
# developers get it from the ggml git submodule, which REF tarballs do not
# contain. Fetch the same qvac-ext-ggml commit the ggml port builds and place
# it at the submodule path so the internal header matches the linked ggml
# exactly. KEEP THIS REF IN LOCKSTEP with ports/ggml/portfile.cmake.
vcpkg_from_github(
    OUT_SOURCE_PATH GGML_SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 9a7d2b36e96a198c1c67c013cafcde4e4c2c60eb
    SHA512 814f00ef4f0e80a2a536a005800e483a2ba9bbcdc72ac6f98a3561b4d3fa0dee7e401b8fd2a68f60d14ecb3a993b0451d1516e4e9157331bdf55e11712309bb5
)
file(REMOVE_RECURSE "${SOURCE_PATH}/ggml")
file(MAKE_DIRECTORY "${SOURCE_PATH}/ggml")
file(GLOB _ggml_tree LIST_DIRECTORIES true "${GGML_SOURCE_PATH}/*")
file(COPY ${_ggml_tree} DESTINATION "${SOURCE_PATH}/ggml")

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

# The linked ggml config calls find_dependency(CUDAToolkit) when its CUDA
# feature is enabled. Point that lookup at the same nvcc used to build ggml;
# otherwise vcpkg's isolated CMake process may inspect /usr/local instead of
# the installed toolkit and fail before stable-diffusion.cpp configures.
set(SD_CUDA_TOOLKIT_OPTIONS "")
if("cuda" IN_LIST FEATURES)
    find_program(SD_NVCC_EXECUTABLE nvcc
        HINTS "$ENV{CUDA_PATH}/bin" "$ENV{CUDA_HOME}/bin"
        PATHS /usr/local/cuda/bin /usr/local/cuda-12.8/bin
    )
    if(NOT SD_NVCC_EXECUTABLE)
        message(FATAL_ERROR "CUDA feature requires nvcc")
    endif()
    file(REAL_PATH "${SD_NVCC_EXECUTABLE}" SD_NVCC_REAL)
    get_filename_component(SD_CUDA_BIN_DIR "${SD_NVCC_REAL}" DIRECTORY)
    get_filename_component(SD_CUDA_ROOT "${SD_CUDA_BIN_DIR}" DIRECTORY)
    list(APPEND SD_CUDA_TOOLKIT_OPTIONS
        "-DCMAKE_CUDA_COMPILER=${SD_NVCC_REAL}"
        "-DCUDAToolkit_ROOT=${SD_CUDA_ROOT}")
endif()

# --- Configure & build ---
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
        ${SD_CUDA_TOOLKIT_OPTIONS}
)

vcpkg_cmake_install()

# --- CMake package config ---
# Ship our own config that defines stable-diffusion::stable-diffusion with
# ggml as a transitive dependency (consumers find_package
# stable-diffusion-cpp). Upstream now installs its own config under
# lib/cmake/stable-diffusion; remove it so there is exactly one source of
# truth and vcpkg's misplaced-cmake-files check stays quiet.
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/lib/cmake"
                    "${CURRENT_PACKAGES_DIR}/debug/lib/cmake")
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake"
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)

vcpkg_fixup_pkgconfig()

# --- Cleanup ---
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
