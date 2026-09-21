# 🔌 API Changes v0.11.2

## Add --include to run:producer

PR: [#4302](https://github.com/tetherto/qvac/pull/4302)

```bash
# Before: the intersection — the 4 parakeet tests that happen to be tagged smoke.
qvac-test run:producer --suite=smoke --filter=parakeet

# After: the union — the smoke suite plus these three tests, whatever their tags.
qvac-test run:producer --suite=smoke \
  --include=parakeet-tdt-mp3,parakeet-ctc-wav,parakeet-unified-mp3
```

```
🏷️  Including suites: smoke
➕ Also running 3 explicitly requested test(s): system-resources-capabilities, …
📋 Filtered: 109 of 513 tests
   system-resources     3/3 (100%)
```

---

