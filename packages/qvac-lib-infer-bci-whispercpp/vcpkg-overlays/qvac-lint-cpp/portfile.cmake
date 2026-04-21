file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/.clang-format" "")
file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/.clang-tidy" "")
file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/.valgrind.supp" "")
file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}/hooks")
file(WRITE "${CURRENT_PACKAGES_DIR}/tools/${PORT}/hooks/pre-commit" "#!/bin/sh\nexit 0\n")
file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/copyright" "Stub overlay port")

