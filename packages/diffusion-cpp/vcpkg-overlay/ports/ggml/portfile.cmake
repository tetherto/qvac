# CUDA-capable local override of the registry ggml port.
#
# Linux QVAC triplets use libc++. CUDA must therefore compile its host objects
# with Clang rather than NVCC's g++ default; otherwise the resulting dynamic
# backend can build but is not ABI-compatible with the consuming addon.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 7d9ce11cd47f338b361a00e866ffe7c224abedff
    SHA512 0c7c99a799a6479d8fbf72d47240119da52d5d4b63ee1ecabf05cf84a0317588ee78939d9c6dba5a881d1bb4fc22765ac0991395cfc47204aa0548fe4c937d15
)

set(GGML_METAL OFF)
set(GGML_VULKAN OFF)
set(GGML_CUDA OFF)
set(GGML_OPENCL OFF)
if("metal" IN_LIST FEATURES)
    set(GGML_METAL ON)
endif()
if("vulkan" IN_LIST FEATURES)
    set(GGML_VULKAN ON)
endif()
if("opencl" IN_LIST FEATURES)
    set(GGML_OPENCL ON)
endif()

set(GGML_CUDA_OPTIONS)
if("cuda" IN_LIST FEATURES)
    set(GGML_CUDA ON)
    find_program(GGML_NVCC_EXECUTABLE NAMES nvcc
        HINTS /usr/local/cuda/bin /usr/local/cuda-13.3/bin /usr/local/cuda-12.8/bin
    )
    if(NOT GGML_NVCC_EXECUTABLE)
        message(FATAL_ERROR "ggml[cuda] requires nvcc")
    endif()
    find_program(GGML_CLANGXX_EXECUTABLE NAMES clang++ REQUIRED)
    list(APPEND GGML_CUDA_OPTIONS
        "-DCMAKE_CUDA_COMPILER=${GGML_NVCC_EXECUTABLE}"
        "-DCMAKE_CUDA_HOST_COMPILER=${GGML_CLANGXX_EXECUTABLE}"
    )
endif()

set(PLATFORM_OPTIONS)
if(VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
endif()
if(VCPKG_TARGET_IS_ANDROID AND "vulkan" IN_LIST FEATURES)
    list(APPEND PLATFORM_OPTIONS -DFETCHCONTENT_FULLY_DISCONNECTED=OFF)
endif()
if(VCPKG_TARGET_IS_ANDROID OR VCPKG_TARGET_IS_LINUX)
    list(APPEND PLATFORM_OPTIONS -DGGML_BACKEND_DL=ON -DGGML_CPU_STATIC=ON)
endif()
if(VCPKG_TARGET_IS_ANDROID)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_VULKAN_DISABLE_COOPMAT=ON
        -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    )
endif()
if(VCPKG_TARGET_IS_LINUX)
    string(APPEND VCPKG_LINKER_FLAGS " -static-libstdc++")
endif()

set(VCPKG_BUILD_TYPE release)
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON
        -DGGML_NATIVE=OFF
        -DGGML_CCACHE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_LLAMAFILE=OFF
        -DGGML_BUILD_TESTS=OFF
        -DGGML_BUILD_EXAMPLES=OFF
        -DGGML_METAL=${GGML_METAL}
        -DGGML_VULKAN=${GGML_VULKAN}
        -DGGML_CUDA=${GGML_CUDA}
        -DGGML_OPENCL=${GGML_OPENCL}
        -DGGML_MAX_NAME=128
        ${GGML_CUDA_OPTIONS}
        ${PLATFORM_OPTIONS}
)
vcpkg_cmake_install()

if(VCPKG_TARGET_IS_ANDROID OR VCPKG_TARGET_IS_LINUX)
    file(GLOB _backend_sos
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libqvac-diffusion-ggml-*.so"
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libqvac-ggml-*.so"
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libggml-*.so"
    )
    if(_backend_sos)
        file(INSTALL ${_backend_sos} DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
    endif()
endif()

vcpkg_cmake_config_fixup(PACKAGE_NAME ggml CONFIG_PATH share/ggml)
if(EXISTS "${CURRENT_PACKAGES_DIR}/share/pkgconfig/ggml.pc")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/lib/pkgconfig")
    file(RENAME "${CURRENT_PACKAGES_DIR}/share/pkgconfig/ggml.pc"
                "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/ggml.pc")
endif()
if(EXISTS "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig/ggml.pc")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig")
    file(RENAME "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig/ggml.pc"
                "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/ggml.pc")
endif()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/share/pkgconfig"
                    "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig")
vcpkg_fixup_pkgconfig()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_POLICY_SKIP_COPYRIGHT_CHECK enabled)
