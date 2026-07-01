#!/usr/bin/env bash
# generate-testspec.sh — Render a Device Farm testspec YAML file.
#
# Called once per test group from upload-to-devicefarm/action.yml.
# Reads configuration from env vars (set by the caller) and writes the
# complete testspec to the file path passed as $1.
#
# Required env:
#   HOST_LINE            — "android_test_host: amazon_linux_2" | "ios_test_host: macos_sequoia"
#   PLATFORM             — "Android" | "iOS"
#   AUTOMATION_NAME      — "UiAutomator2" | "XCUITest"
#   WDIO_CONFIG_B64      — base64-encoded wdio.config.devicefarm.js
#
# Optional env:
#   PERF_EXTRACT_B64     — base64-encoded perf-extract.js (empty = skip)
#   SHARD_ENABLES_PERF   — "true" to wire perf bridging for this shard (set per-group by action.yml)
#   ENABLES_PERF         — (legacy) global fallback if SHARD_ENABLES_PERF is unset
#   QVAC_PERF_RUNS       — override for QVAC_PERF_RUNS
#   QVAC_PERF_WARMUP_RUNS — override for QVAC_PERF_WARMUP_RUNS
#   QVAC_PERF_ONLY       — restrict to perf tests only
#   AFTER_PULLS          — JSON array of {device_path, artifact_name} pairs
#
# Optional files (paths supplied by the caller via env, fall back to
# /tmp/* for backwards-compat with one-off local runs):
#   $EXTRA_PRE_TEST_PATH  / /tmp/extra-pre-test.sh  — consumer pre_test commands
#   $EXTRA_POST_TEST_PATH / /tmp/extra-post-test.sh — consumer post_test commands
set -euo pipefail

SPEC_FILE="${1:?Usage: generate-testspec.sh <output-file>}"

# ── emit_extra_commands ───────────────────────────────────────────────
# Reads a file of consumer-supplied commands and emits them as testspec
# YAML list items. Supports YAML literal blocks: a line containing only
# "|" opens a block; subsequent lines indented with 2+ spaces are block
# content; the first non-indented line ends the block.
emit_extra_commands() {
  local src="$1"
  [ -s "$src" ] || return 0
  local _in_block=false
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$_in_block" = "true" ]; then
      case "$line" in "  "*)
        printf '        %s\n' "${line#  }"
        continue ;; esac
      _in_block=false
    fi
    [ -z "$line" ] && continue
    if [ "$line" = "|" ]; then
      printf '      - |\n'
      _in_block=true
    else
      printf '      - %s\n' "$line"
    fi
  done < "$src"
}

# ── main: write testspec ──────────────────────────────────────────────
{
# --- Header + install phase ---
cat <<EOF
version: 0.1
${HOST_LINE}

phases:
  install:
    commands:
      - export NVM_DIR=\$HOME/.nvm
      - . \$NVM_DIR/nvm.sh 2>/dev/null || true
      - nvm install 18 2>/dev/null || true
      - nvm use 18 2>/dev/null || true
      - node --version || echo "Using system node"

  pre_test:
    commands:
      - cd \$DEVICEFARM_TEST_PACKAGE_PATH
      - rm -rf node_modules package-lock.json 2>/dev/null || true
      - npm install --legacy-peer-deps 2>&1
      - echo "Decoding wdio config..."
      - echo "${WDIO_CONFIG_B64}" | base64 -d > tests/wdio.config.devicefarm.js
EOF

# --- Optional: perf-extract.js deployment ---
_shard_perf="${SHARD_ENABLES_PERF:-${ENABLES_PERF:-false}}"
if [ -n "${PERF_EXTRACT_B64:-}" ] && [ "$_shard_perf" = "true" ]; then
  cat <<EOF
      - echo "${PERF_EXTRACT_B64}" | base64 -d > tests/perf-extract.js
EOF
fi

# --- Optional: perf bridging config ---
if [ "$_shard_perf" = "true" ]; then
  cat <<EOF
      - echo "Perf bridging: runs=${QVAC_PERF_RUNS:-} warmup=${QVAC_PERF_WARMUP_RUNS:-} only=${QVAC_PERF_ONLY:-}"
      - echo "QVAC_PERF_RUNS=${QVAC_PERF_RUNS:-}" > /tmp/qvacPerfConfig.txt
      - echo "QVAC_PERF_WARMUP_RUNS=${QVAC_PERF_WARMUP_RUNS:-}" >> /tmp/qvacPerfConfig.txt
      - echo "QVAC_PERF_ONLY=${QVAC_PERF_ONLY:-}" >> /tmp/qvacPerfConfig.txt
EOF
fi

# --- Platform-specific pre-test commands ---
if [ "$PLATFORM" = "Android" ]; then
  cat <<'EOF'
      - adb shell logcat -G 16M 2>/dev/null || true
      - adb shell mkdir -p /sdcard/Android/data/io.tether.test.qvac/files/ 2>/dev/null || true
EOF
fi

emit_extra_commands "${EXTRA_PRE_TEST_PATH:-/tmp/extra-pre-test.sh}"

if [ "$PLATFORM" = "iOS" ]; then
  cat <<'EOF'
      - export DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH=$DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH_V9
EOF
fi

# --- Appium startup ---
cat <<EOF
      - export APPIUM_BASE_PATH=/wd/hub
      - |
        appium --base-path=\$APPIUM_BASE_PATH --log-timestamp \\
          --log-no-colors --relaxed-security --default-capabilities \\
          "{\"appium:deviceName\": \"\$DEVICEFARM_DEVICE_NAME\", \\
          \"platformName\": \"\$DEVICEFARM_DEVICE_PLATFORM_NAME\", \\
          \"appium:app\": \"\$DEVICEFARM_APP_PATH\", \\
          \"appium:udid\":\"\$DEVICEFARM_DEVICE_UDID\", \\
          \"appium:platformVersion\": \"\$DEVICEFARM_DEVICE_OS_VERSION\", \\
          \"appium:chromedriverExecutableDir\": \"\$DEVICEFARM_CHROMEDRIVER_EXECUTABLE_DIR\", \\
          \"appium:wdaLocalPort\": 8100, \\
          \"appium:derivedDataPath\": \"\$DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH\", \\
          \"appium:usePrebuiltWDA\": true, \\
          \"appium:automationName\": \"${AUTOMATION_NAME}\"}" \\
          >> \$DEVICEFARM_LOG_DIR/appium.log 2>&1 &
      - |
        appium_initialization_time=0
        until curl --silent --fail "http://0.0.0.0:4723\${APPIUM_BASE_PATH}/status"; do
          if [[ \$appium_initialization_time -gt 30 ]]; then
            cat \$DEVICEFARM_LOG_DIR/appium.log
            exit 1
          fi
          appium_initialization_time=\$((appium_initialization_time + 1))
          sleep 1
        done

  test:
    commands:
      - cd \$DEVICEFARM_TEST_PACKAGE_PATH
      - node node_modules/@wdio/cli/bin/wdio.js run tests/wdio.config.devicefarm.js

  post_test:
    commands:
      - echo "Test completed"
      - |
        if [ -s "\$DEVICEFARM_LOG_DIR/test-results.json" ]; then
          echo "[TEST_RESULTS_START]"
          cat "\$DEVICEFARM_LOG_DIR/test-results.json"
          echo ""
          echo "[TEST_RESULTS_END]"
        fi
EOF

# --- Optional: perf report extraction ---
if [ "$_shard_perf" = "true" ]; then
  cat <<'EOF'
      - echo "Looking for perf-report-extract.json..."
      - |
        for p in "$DEVICEFARM_LOG_DIR/perf-report-extract.json" "$DEVICEFARM_TEST_PACKAGE_PATH/perf-report-extract.json" "$DEVICEFARM_TEST_PACKAGE_PATH/tests/perf-report-extract.json"; do
          if [ -s "$p" ]; then
            echo "[PERF_REPORT_START]"
            cat "$p"
            echo ""
            echo "[PERF_REPORT_END]"
            break
          fi
        done
EOF
fi

# --- Platform-specific post-test log collection ---
if [ "$PLATFORM" = "Android" ]; then
  cat <<'EOF'
      - adb logcat -d -b all > $DEVICEFARM_LOG_DIR/logcat_full.txt 2>/dev/null || true
EOF
fi

cat <<'EOF'
      - echo "Available log files:"
      - ls -lh $DEVICEFARM_LOG_DIR/ || true
EOF

emit_extra_commands "${EXTRA_POST_TEST_PATH:-/tmp/extra-post-test.sh}"

# --- Custom artifact pulls (consumer-supplied JSON array) ---
PULL_LINES=$(python3 -c "
import json, sys, os
try:
    arr = json.loads(os.environ.get('AFTER_PULLS', '[]'))
except Exception:
    arr = []
for item in arr:
    dp = item.get('device_path', '')
    an = item.get('artifact_name', '')
    if dp and an:
        print(f'cp -r {dp} \$DEVICEFARM_LOG_DIR/{an} 2>/dev/null || true')
")
if [ -n "$PULL_LINES" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '      - %s\n' "$line"
  done <<< "$PULL_LINES"
fi

# --- Artifacts ---
cat <<'EOF'

artifacts:
  - $DEVICEFARM_LOG_DIR
EOF
} > "$SPEC_FILE"
