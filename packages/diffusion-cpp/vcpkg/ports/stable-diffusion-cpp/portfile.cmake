# QVAC-25129: temporary overlay for tetherto/qvac-ext-stable-diffusion.cpp#42.
# Based on the published 2026-08-11#1 port; only the engine source pin changes.
# Remove after the engine and registry repin merge. Keep ggml on its published pin.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 44875945bdca55472ec64d33badb11e558b98e5d
    SHA512 7482b493ebe70ed547d809478fe1570c31fa976db79bf27573c1ef96af4579846e3e9d04beef9fc1e9d209b1439878d78c02c4948d9baec6db4e55ea5ea8b780
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
    REF 7d9ce11cd47f338b361a00e866ffe7c224abedff
    SHA512 0c7c99a799a6479d8fbf72d47240119da52d5d4b63ee1ecabf05cf84a0317588ee78939d9c6dba5a881d1bb4fc22765ac0991395cfc47204aa0548fe4c937d15
)
file(REMOVE_RECURSE "${SOURCE_PATH}/ggml")
file(MAKE_DIRECTORY "${SOURCE_PATH}/ggml")
file(GLOB _ggml_tree LIST_DIRECTORIES true "${GGML_SOURCE_PATH}/*")
file(COPY ${_ggml_tree} DESTINATION "${SOURCE_PATH}/ggml")

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

# --- Configure & build ---
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
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
