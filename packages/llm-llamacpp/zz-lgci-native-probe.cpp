// Throwaway native probe for caching isolation test (QVAC-21199 follow-up).
// A UNIQUE native file → unique native_hash → unique cache key, so this run
// cannot collide with the identical-content certification PRs. Not referenced
// by CMake (never compiled); exists only to make native_changed=true and the
// cache key distinct. Delete with the branch.
int lgci_native_probe_unique_8f3a() { return 0; }
