// Global test environment: give the test binary a temp directory of its own.
//
// Tests put cache files under std::filesystem::temp_directory_path() with
// fixed names, and an unload now writes a cached conversation's unsaved turns
// to its file, so a file can outlive the test that removed it. On a CI host
// shared by several runner users, the next run under another user then cannot
// remove it from the sticky /tmp ("Operation not permitted"). Pointing TMPDIR
// at a per-user directory before the first test keeps every such file private
// to the user that wrote it; the directory is emptied after the last test, once
// every model has unloaded. Windows' temp dir is already per user.

#include <filesystem>
#include <string>

#include <gtest/gtest.h>

#ifndef _WIN32
#include <cstdlib>

#include <unistd.h>
#endif

namespace {

class PerUserTempDirEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
#ifndef _WIN32
    std::error_code ec;
    const std::filesystem::path base = std::filesystem::temp_directory_path(ec);
    if (ec) {
      return;
    }
    const std::filesystem::path dir =
        base / ("qvac-llm-addon-test-" + std::to_string(::getuid()));
    std::filesystem::create_directories(dir, ec);
    if (ec) {
      return;
    }
    std::filesystem::permissions(
        dir,
        std::filesystem::perms::owner_all,
        std::filesystem::perm_options::replace,
        ec);
    ::setenv("TMPDIR", dir.c_str(), 1);
    dir_ = dir;
#endif
  }

  void TearDown() override {
    if (dir_.empty()) {
      return;
    }
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator(dir_, ec)) {
      std::filesystem::remove_all(entry.path(), ec);
    }
  }

private:
  std::filesystem::path dir_;
};

const ::testing::Environment* const kPerUserTempDirEnv =
    ::testing::AddGlobalTestEnvironment(new PerUserTempDirEnvironment);

} // namespace
