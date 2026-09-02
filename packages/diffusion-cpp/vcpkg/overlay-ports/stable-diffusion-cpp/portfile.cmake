# stable-diffusion.cpp vcpkg overlay port  — TEMPORARY, ABot-World fix line
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
# WHY THIS OVERLAY EXISTS (drop before merge):
#   The published registry port `stable-diffusion-cpp@2026-08-11` builds the
#   engine at tip 7e31701, which carries the 2026-08-11 forward-port's ABot
#   scene-creation quality regression (prompt padding no longer zeroed). This
#   overlay pins the engine to the fix branch tip so the addon's ABot lanes —
#   including the new pack-conditioning and frame-quality guards in this PR —
#   build and pass against the corrected engine. It is identical to the
#   registry port except for the engine REF/SHA512 below; the ggml REF is
#   unchanged and stays in lockstep. Remove this overlay (and the
#   overlay-ports entry in vcpkg-configuration.json) and bump the vcpkg.json
#   dependency to the published port revision once the engine PR merges and
#   qvac-registry-vcpkg publishes the fixed REF — per the
#   overlay-transits-the-PR-branch process.
#
#   REF 187ec98 = tetherto/qvac-ext-stable-diffusion.cpp branch
#   fix/abot-scene-prompt-pad-zeroing (base 2026-08-11 @ 7e31701 + the ABot
#   quality fix, live prompt-row reporting, and the walk perf commits). The
#   ABot-World session/scene C API is unchanged from the base line.
#
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 187ec98ab57390199b8b31011657d82eb19ecf03
    SHA512 071eedcfe3a851643fd355626cd086d7273316075effdc9fee458e38efbb3ef38b416925f462d4deb80264feb6976a4396194be0903d53d9dcade64e73947a37
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
