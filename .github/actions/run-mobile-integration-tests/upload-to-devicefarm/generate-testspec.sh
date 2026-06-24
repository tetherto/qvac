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
#   ENABLES_PERF         — "true" to wire perf bridging + post_test extraction
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
  printf 'version: 0.1\n'
  printf '%s\n' "$HOST_LINE"
  printf '\n'
  printf 'phases:\n'
  printf '  install:\n'
  printf '    commands:\n'
  printf '      - export NVM_DIR=$HOME/.nvm\n'
  printf '      - . $NVM_DIR/nvm.sh 2>/dev/null || true\n'
  printf '      - nvm install 18 2>/dev/null || true\n'
  printf '      - nvm use 18 2>/dev/null || true\n'
  printf '      - node --version || echo "Using system node"\n'
  printf '\n'
  printf '  pre_test:\n'
  printf '    commands:\n'
  printf '      - cd $DEVICEFARM_TEST_PACKAGE_PATH\n'
  printf '      - rm -rf node_modules package-lock.json 2>/dev/null || true\n'
  printf '      - npm install --legacy-peer-deps 2>&1\n'
  printf '      - echo "Decoding wdio config..."\n'
  printf '      - echo "%s" | base64 -d > tests/wdio.config.devicefarm.js\n' "$WDIO_CONFIG_B64"
  if [ -n "${PERF_EXTRACT_B64:-}" ]; then
    printf '      - echo "%s" | base64 -d > tests/perf-extract.js\n' "$PERF_EXTRACT_B64"
  fi

  if [ "${ENABLES_PERF:-false}" = "true" ]; then
    printf '      - echo "Perf bridging: runs=%s warmup=%s only=%s"\n' \
      "${QVAC_PERF_RUNS:-}" "${QVAC_PERF_WARMUP_RUNS:-}" "${QVAC_PERF_ONLY:-}"
    printf '      - echo "QVAC_PERF_RUNS=%s" > /tmp/qvacPerfConfig.txt\n' "${QVAC_PERF_RUNS:-}"
    printf '      - echo "QVAC_PERF_WARMUP_RUNS=%s" >> /tmp/qvacPerfConfig.txt\n' "${QVAC_PERF_WARMUP_RUNS:-}"
    printf '      - echo "QVAC_PERF_ONLY=%s" >> /tmp/qvacPerfConfig.txt\n' "${QVAC_PERF_ONLY:-}"
  fi

  # Default Android pre-test: larger logcat buffer + ensure app data dir exists.
  if [ "$PLATFORM" = "Android" ]; then
    printf '      - adb shell logcat -G 16M 2>/dev/null || true\n'
    printf '      - adb shell mkdir -p /sdcard/Android/data/io.tether.test.qvac/files/ 2>/dev/null || true\n'
  fi

  emit_extra_commands "${EXTRA_PRE_TEST_PATH:-/tmp/extra-pre-test.sh}"

  if [ "$PLATFORM" = "iOS" ]; then
    printf '      - export DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH=$DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH_V9\n'
  fi

  printf '      - export APPIUM_BASE_PATH=/wd/hub\n'
  printf '      - |\n'
  printf '        appium --base-path=$APPIUM_BASE_PATH --log-timestamp \\\n'
  printf '          --log-no-colors --relaxed-security --default-capabilities \\\n'
  printf '          "{\\"appium:deviceName\\": \\"$DEVICEFARM_DEVICE_NAME\\", \\\n'
  printf '          \\"platformName\\": \\"$DEVICEFARM_DEVICE_PLATFORM_NAME\\", \\\n'
  printf '          \\"appium:app\\": \\"$DEVICEFARM_APP_PATH\\", \\\n'
  printf '          \\"appium:udid\\":\\"$DEVICEFARM_DEVICE_UDID\\", \\\n'
  printf '          \\"appium:platformVersion\\": \\"$DEVICEFARM_DEVICE_OS_VERSION\\", \\\n'
  printf '          \\"appium:chromedriverExecutableDir\\": \\"$DEVICEFARM_CHROMEDRIVER_EXECUTABLE_DIR\\", \\\n'
  printf '          \\"appium:wdaLocalPort\\": 8100, \\\n'
  printf '          \\"appium:derivedDataPath\\": \\"$DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH\\", \\\n'
  printf '          \\"appium:usePrebuiltWDA\\": true, \\\n'
  printf '          \\"appium:automationName\\": \\"%s\\"}" \\\n' "$AUTOMATION_NAME"
  printf '          >> $DEVICEFARM_LOG_DIR/appium.log 2>&1 &\n'
  printf '      - |\n'
  printf '        appium_initialization_time=0\n'
  printf '        until curl --silent --fail "http://0.0.0.0:4723${APPIUM_BASE_PATH}/status"; do\n'
  printf '          if [[ $appium_initialization_time -gt 30 ]]; then\n'
  printf '            cat $DEVICEFARM_LOG_DIR/appium.log\n'
  printf '            exit 1\n'
  printf '          fi\n'
  printf '          appium_initialization_time=$((appium_initialization_time + 1))\n'
  printf '          sleep 1\n'
  printf '        done\n'
  printf '\n'
  printf '  test:\n'
  printf '    commands:\n'
  printf '      - cd $DEVICEFARM_TEST_PACKAGE_PATH\n'
  printf '      - node node_modules/@wdio/cli/bin/wdio.js run tests/wdio.config.devicefarm.js\n'
  printf '\n'
  printf '  post_test:\n'
  printf '    commands:\n'
  printf '      - echo "Test completed"\n'

  # Emit test-results.json (written incrementally by wdio.template.js) into
  # the log stream between markers so it can be extracted from raw logs too.
  printf '      - |\n'
  printf '        if [ -s "$DEVICEFARM_LOG_DIR/test-results.json" ]; then\n'
  printf '          echo "[TEST_RESULTS_START]"\n'
  printf '          cat "$DEVICEFARM_LOG_DIR/test-results.json"\n'
  printf '          echo ""\n'
  printf '          echo "[TEST_RESULTS_END]"\n'
  printf '        fi\n'

  if [ "${ENABLES_PERF:-false}" = "true" ]; then
    printf '      - echo "Looking for perf-report-extract.json..."\n'
    printf '      - |\n'
    printf '        for p in "$DEVICEFARM_LOG_DIR/perf-report-extract.json" "$DEVICEFARM_TEST_PACKAGE_PATH/perf-report-extract.json" "$DEVICEFARM_TEST_PACKAGE_PATH/tests/perf-report-extract.json"; do\n'
    printf '          if [ -s "$p" ]; then\n'
    printf '            echo "[PERF_REPORT_START]"\n'
    printf '            cat "$p"\n'
    printf '            echo ""\n'
    printf '            echo "[PERF_REPORT_END]"\n'
    printf '            break\n'
    printf '          fi\n'
    printf '        done\n'
  fi

  # Default post-test log collection.
  if [ "$PLATFORM" = "Android" ]; then
    printf '      - adb logcat -d -b all > $DEVICEFARM_LOG_DIR/logcat_full.txt 2>/dev/null || true\n'
  fi
  printf '      - echo "Available log files:"\n'
  printf '      - ls -lh $DEVICEFARM_LOG_DIR/ || true\n'

  emit_extra_commands "${EXTRA_POST_TEST_PATH:-/tmp/extra-post-test.sh}"

  # Custom artifact pulls (consumer-supplied JSON array).
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

  printf '\n'
  printf 'artifacts:\n'
  printf '  - $DEVICEFARM_LOG_DIR\n'
} > "$SPEC_FILE"
