cmake_minimum_required(VERSION 3.25)

project(lint-cpp)

# Install formatting and linting configuration files
install(
    FILES
        .clang-format
        .clang-tidy
        .valgrind.supp
    DESTINATION share/lint-cpp
)

# Install the hook as a program so it keeps +x (POSIX)
install(
    PROGRAMS
        hooks/pre-commit
    DESTINATION tools/lint-cpp/hooks
)

# Install helper script alongside config files
install(
    PROGRAMS
        tools/clang-tidy-helper.py
    DESTINATION tools/lint-cpp
)

