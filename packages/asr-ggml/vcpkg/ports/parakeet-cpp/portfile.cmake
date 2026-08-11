# parakeet-cpp: NVIDIA Parakeet ASR + Sortformer diarization in pure C++/ggml,
# from the engines/parakeet/ subfolder of tetherto/qvac-ext-lib-whisper.cpp;
# consumes the ggml-speech port.
#
# The installable artifacts live under the `qvac-parakeet` name so this port is
# co-installable with whisper-cpp, whose upstream v1.9.1+ installs its own
# parakeet library and CMake package. Consumers use
# find_package(qvac-parakeet CONFIG) + qvac::parakeet; the C++ `parakeet::`
# namespace and the include/parakeet/ directory are unchanged.
#
# Pinned at ef489ebb from qvac-ext-lib-whisper.cpp#142 for deterministic
# Sortformer streaming finalization: trailing real segments stay non-final and
# each non-cancelled session emits exactly one synthetic final terminator.
# ggml-speech floor stays at 2026-08-07.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH WHISPER_CPP_SRC
    REPO tetherto/qvac-ext-lib-whisper.cpp
    REF ef489ebbb3d9a49d6d9f448af22a8c1fca335af4
    SHA512 7567ac45485fb148f42d6a5765227d12267b441c6383835a35ddb9c78c6a704faefb5b834df79bbe1311f5f4fb08b162654c2e11fcf23e6c2f542bbc39efad4f
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

set(PARAKEET_COREML OFF)
if("coreml" IN_LIST FEATURES)
    set(PARAKEET_COREML ON)
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
        -DPARAKEET_COREML=${PARAKEET_COREML}
)

vcpkg_cmake_install()

# The engine installs its package config to lib/cmake/qvac-parakeet (was
# share/parakeet-cpp) under the new namespace; the imported target is
# qvac::parakeet.
vcpkg_cmake_config_fixup(PACKAGE_NAME qvac-parakeet CONFIG_PATH lib/cmake/qvac-parakeet)

# The engine installs lib/pkgconfig/qvac-parakeet.pc carrying absolute -L/-I
# into this machine's install prefix, which would break every consumer that
# restores the package from the binary cache. vcpkg_fixup_pkgconfig() rewrites
# them by exact string match only, and the two sides can disagree on spelling
# (macOS /tmp vs /private/tmp), so normalise by meaning instead: rewrite any
# absolute -L/-I whose realpath lands inside the prefix to ${prefix}-relative.
# The shipped .pc is complete for CMake consumers and for pkg-config against a
# shared ggml; a static-ggml pkg-config link still misses the backend
# registration symbols, tracked as an engine follow-up.
get_filename_component(PARAKEET_INSTALLED_REALPATH "${CURRENT_INSTALLED_DIR}" REALPATH)

function(parakeet_relativize_pc pc_file)
    if (NOT EXISTS "${pc_file}")
        return()
    endif()
    file(READ "${pc_file}" contents)
    string(REGEX MATCHALL "-[LI][^ \t\r\n\"]+" tokens "${contents}")
    foreach (token IN LISTS tokens)
        string(SUBSTRING "${token}" 0 2 flag)
        string(SUBSTRING "${token}" 2 -1 dir)
        if (NOT IS_ABSOLUTE "${dir}")
            continue()
        endif()
        get_filename_component(dir_real "${dir}" REALPATH)
        # Only touch paths inside our own prefix; a genuinely external dep
        # (e.g. a system OpenMP runtime) must keep its absolute path.
        string(FIND "${dir_real}" "${PARAKEET_INSTALLED_REALPATH}/" hit)
        if (NOT hit EQUAL 0)
            continue()
        endif()
        string(LENGTH "${PARAKEET_INSTALLED_REALPATH}/" prefix_len)
        string(SUBSTRING "${dir_real}" ${prefix_len} -1 rel)
        string(REPLACE "${token}" "${flag}\${prefix}/${rel}" contents "${contents}")
    endforeach()
    file(WRITE "${pc_file}" "${contents}")
endfunction()

file(GLOB PARAKEET_PC_FILES
    "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/*.pc"
    "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/*.pc")
foreach (PARAKEET_PC_FILE IN LISTS PARAKEET_PC_FILES)
    parakeet_relativize_pc("${PARAKEET_PC_FILE}")
endforeach()

vcpkg_fixup_pkgconfig()

# Guard the outcome by meaning, not by spelling: after the rewrites no -L/-I in
# the shipped .pc may still resolve into this machine's install/package/build
# trees. Cheap, and it turns a silently non-relocatable package into a build
# failure here.
file(GLOB PARAKEET_PC_FILES "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/*.pc")
foreach (PARAKEET_PC_FILE IN LISTS PARAKEET_PC_FILES)
    file(READ "${PARAKEET_PC_FILE}" PARAKEET_PC_CONTENTS)
    string(REGEX MATCHALL "-[LI][^ \t\r\n\"]+" PARAKEET_PC_TOKENS "${PARAKEET_PC_CONTENTS}")
    foreach (PARAKEET_PC_TOKEN IN LISTS PARAKEET_PC_TOKENS)
        string(SUBSTRING "${PARAKEET_PC_TOKEN}" 2 -1 PARAKEET_PC_DIR)
        if (NOT IS_ABSOLUTE "${PARAKEET_PC_DIR}")
            continue()
        endif()
        get_filename_component(PARAKEET_PC_DIR_REAL "${PARAKEET_PC_DIR}" REALPATH)
        foreach (PARAKEET_TREE
                 "${PARAKEET_INSTALLED_REALPATH}" "${CURRENT_PACKAGES_DIR}" "${CURRENT_BUILDTREES_DIR}")
            get_filename_component(PARAKEET_TREE_REAL "${PARAKEET_TREE}" REALPATH)
            string(FIND "${PARAKEET_PC_DIR_REAL}" "${PARAKEET_TREE_REAL}" PARAKEET_TREE_HIT)
            if (PARAKEET_TREE_HIT EQUAL 0)
                message(FATAL_ERROR
                    "parakeet-cpp: ${PARAKEET_PC_FILE} still contains '${PARAKEET_PC_TOKEN}', which "
                    "resolves inside ${PARAKEET_TREE_REAL}. The packaged .pc would not be "
                    "relocatable and would break consumers restoring this package from the "
                    "binary cache.")
            endif()
        endforeach()
    endforeach()
endforeach()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
