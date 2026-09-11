# CUDA-capable local override of the registry stable-diffusion-cpp port.
#
# This remains source-compatible with the 2026-08-11 registry port but passes
# the CUDA 13 target-layout paths while vcpkg configures the dependency. The
# addon CMakeLists runs after this install, so it cannot provide these values
# in time for ggml's exported CMake package.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF f817406215aa1d27f3ac3306647b1e1ded2f6d1b
    SHA512 5fa199dd2c74e17213d653d0079b5d8690df9075725d571228fea85c851714536db3916c550ea7de22a91f22eea56c37fbbf496bb5908fe25743aa0900a36976
)

vcpkg_from_github(
    OUT_SOURCE_PATH GGML_SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 7d9ce11cd47f338b361a00e866ffe7c224abedff
    SHA512 0c7c99a799a6479d8fbf72d47240119da52d5d4b63ee1ecabf05cf84a0317588ee78939d9c6dba5a881d1bb4fc22765ac0991395cfc47204aa0548fe4c937d15
)
file(REMOVE_RECURSE "${SOURCE_PATH}/ggml")
file(MAKE_DIRECTORY "${SOURCE_PATH}/ggml")
file(GLOB _ggml_tree LIST_DIRECTORIES true "${GGML_SOURCE_PATH}/*")
file(COPY ${_ggml_tree} DESTINATION "${SOURCE_PATH}/ggml")

set(SD_CUDA_OPTIONS)
if("cuda" IN_LIST FEATURES)
    find_program(SD_NVCC_EXECUTABLE NAMES nvcc
        HINTS /usr/local/cuda/bin /usr/local/cuda-13.3/bin /usr/local/cuda-12.8/bin
    )
    if(NOT SD_NVCC_EXECUTABLE)
        message(FATAL_ERROR "stable-diffusion-cpp[cuda] requires nvcc")
    endif()
    find_program(SD_CLANGXX_EXECUTABLE NAMES clang++ REQUIRED)
    get_filename_component(SD_CUDA_BIN_DIR "${SD_NVCC_EXECUTABLE}" DIRECTORY)
    get_filename_component(SD_CUDA_TOOLKIT_ROOT "${SD_CUDA_BIN_DIR}" DIRECTORY)
    find_path(SD_CUDA_INCLUDE_DIR cuda_runtime.h
        HINTS
            "${SD_CUDA_TOOLKIT_ROOT}/targets/x86_64-linux/include"
            "${SD_CUDA_TOOLKIT_ROOT}/include"
        REQUIRED
    )
    get_filename_component(SD_CUDA_TARGET_DIR "${SD_CUDA_INCLUDE_DIR}" DIRECTORY)
    list(APPEND SD_CUDA_OPTIONS
        -DSD_CUDA=ON
        "-DCMAKE_CUDA_COMPILER=${SD_NVCC_EXECUTABLE}"
        "-DCMAKE_CUDA_HOST_COMPILER=${SD_CLANGXX_EXECUTABLE}"
        "-DCUDAToolkit_ROOT=${SD_CUDA_TOOLKIT_ROOT}"
        "-DCUDAToolkit_TARGET_DIR=${SD_CUDA_TARGET_DIR}"
        "-DCUDAToolkit_INCLUDE_DIRECTORIES=${SD_CUDA_INCLUDE_DIR}"
    )
endif()

set(VCPKG_BUILD_TYPE release)
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
        ${SD_CUDA_OPTIONS}
)
vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/lib/cmake"
                    "${CURRENT_PACKAGES_DIR}/debug/lib/cmake")
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake"
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)
vcpkg_fixup_pkgconfig()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
