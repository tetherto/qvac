if(VCPKG_TARGET_IS_WINDOWS)
    vcpkg_check_linkage(ONLY_STATIC_LIBRARY)
endif()

set(XNNPACK_PATCHES
    fix-build.patch
    disable_gcc_warning.patch
)
if(VCPKG_TARGET_IS_WINDOWS)
    list(APPEND XNNPACK_PATCHES fix-windows-pthreadpool.patch)
endif()

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO google/XNNPACK
    REF 953dcb96cc1b21b4b966952f8ee67a9e1f0d3e71
    SHA512 8c12930ef3b2f832962682d73c362518c014bb4e56d0c5cad2b8b63a03c91dccf6e6a3fd0eb91931fc5872c7df9773e76bf08553fc9c3cc22c94636c74815e94
    HEAD_REF master
    PATCHES ${XNNPACK_PATCHES}
)
vcpkg_find_acquire_program(PYTHON3)

# XNNPACK's AMD64 microkernels are GAS-syntax (.intel_syntax) .S files that
# MSVC's ml64 cannot assemble. Enabling the ASM language together with a
# static-CRT triplet also trips CMake's "MSVC_RUNTIME_LIBRARY value
# 'MultiThreaded' not known for this ASM compiler" generate error. Fall back to
# the intrinsic kernels on Windows; keep hand-written assembly everywhere else.
set(XNNPACK_ENABLE_ASSEMBLY ON)
if(VCPKG_TARGET_IS_WINDOWS)
    set(XNNPACK_ENABLE_ASSEMBLY OFF)
endif()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        "-DPython3_EXECUTABLE=${PYTHON3}"
        "-DPython_EXECUTABLE=${PYTHON3}"
        -DXNNPACK_USE_SYSTEM_LIBS=ON
        -DXNNPACK_ENABLE_AVXVNNI=OFF
        "-DXNNPACK_ENABLE_ASSEMBLY=${XNNPACK_ENABLE_ASSEMBLY}"
        -DXNNPACK_ENABLE_MEMOPT=ON
        -DXNNPACK_ENABLE_SPARSE=ON
        -DXNNPACK_ENABLE_KLEIDIAI=OFF
        -DXNNPACK_BUILD_TESTS=OFF
        -DXNNPACK_BUILD_BENCHMARKS=OFF
)
vcpkg_cmake_install()
vcpkg_copy_pdbs()

file(INSTALL "${SOURCE_PATH}/LICENSE" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME copyright)
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include"
    "${CURRENT_PACKAGES_DIR}/debug/bin"
    "${CURRENT_PACKAGES_DIR}/debug/share"
)
