# 🔌 API Changes v0.14.0

## Update @qvac/tts-ggml to 0.9.1

PR: [#4428](https://github.com/tetherto/qvac/pull/4428)

```bash
# tts-ggml 0.9.0 installs the host's binaries next to the meta package
node_modules/@qvac/tts-ggml/                    # JavaScript only: addon: true, no prebuilds/
node_modules/@qvac/tts-ggml-darwin-arm64/       # os/cpu filtered optionalDependency
  addon/package.json                            # { "name": "@qvac/tts-ggml", "addon": true }
  addon/prebuilds/darwin-arm64/qvac__tts-ggml.bare

# Passes on this branch; on main it reports missing-prebuild for every host
qvac verify bundle --addons-source ./node_modules --host darwin-arm64
```

```text
@qvac/tts-ggml@0.9.0 is missing a prebuild for linux-x64
(expected …/@qvac/tts-ggml/prebuilds/linux-x64/*.bare).
No per-platform package @qvac/tts-ggml-linux-x64 is installed alongside it either.
```

---
