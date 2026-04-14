# qvac-lint-cpp

This repository contains the configuration files that are used to format and
lint the C++ source files in QVAC repositories. It also has pre-commit hooks for git.

## Usage

Use `vcpkg` to get the latest configuration files. An ideal way would be as
follows.

1. Add this repository as a dependency in your `vcpkg.json`. A minimal
   `portfile.cmake` is provided below.

```cmake
# vcpkg/ports/qvac-lint-cpp/portfile.cmake
set(QVAC_LINT_CPP "https://github.com/tetherto/qvac-lint-cpp.git")

find_package(Git REQUIRED)
execute_process(
  COMMAND ${GIT_EXECUTABLE} ls-remote --tags --refs --sort=-v:refname "${QVAC_LINT_CPP}"
  OUTPUT_VARIABLE remote_tags
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)

# See git ls-remote --help for output format
# Given a list like the following, we need to get the first commit.
# d1e7f85d50a68ab8df7f79a68b5af557ed75f9c8	refs/tags/v1.7.1
# 58bd1bfdf0a10112d6e02238454ce398cdcf92d1	refs/tags/v1.7.0
# eeff6ba4928cdbc51097c7bfb40a54b494446730	refs/tags/v1.6.0
# 209e65fb8b3b751725fe61c81f679dc76696dc25	refs/tags/v1.5.0
string(REPLACE "\t" ";" remote_tags_list "${remote_tags}")
list(GET remote_tags_list 0 latest_commit)
list(GET remote_tags_list 1 latest_tag)

message("Using qvac-cpp-lint: ${latest_commit} (${latest_tag})")

vcpkg_from_git(
  OUT_SOURCE_PATH SOURCE_PATH
  URL "${QVAC_LINT_CPP}"
  REF "${latest_commit}")

vcpkg_cmake_configure(SOURCE_PATH "${SOURCE_PATH}")

vcpkg_cmake_install()

set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
```

2. Copy the configuration files from this pseudo-package using CMake.

```cmake
find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/qvac-lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)
```

Now `.clang-format` file will be available in your project's source root.
