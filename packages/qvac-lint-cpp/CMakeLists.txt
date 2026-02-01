cmake_minimum_required(VERSION 3.25)

project(qvac-lint-cpp)

# Install formatting and linting configuration files
install(
    FILES
        .clang-format
        .clang-tidy
        .valgrind.supp
    DESTINATION share/qvac-lint-cpp
)

# Install the hook as a program so it keeps +x (POSIX)
install(
    PROGRAMS
        hooks/pre-commit
    DESTINATION tools/qvac-lint-cpp/hooks
)

# Install helper script alongside config files
install(
    PROGRAMS
        tools/clang-tidy-helper.py
    DESTINATION tools/qvac-lint-cpp
)

