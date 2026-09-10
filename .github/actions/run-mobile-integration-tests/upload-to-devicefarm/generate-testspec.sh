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
#   GROUP_GREP_B64       — base64-encoded grep for this test-spec shard
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
      # Device Farm ships Node + Appium via devicefarm-cli on both the
      # amazon_linux_2 (Android) and macos_sequoia (iOS) hosts. The addon
      # e2e harness pins the Appium 3 stack (appium-xcuitest-driver@12,
      # appium-uiautomator2-driver@8, @appium/support@7), which requires
      # Node ^20.19 || ^22.12 || >=24 and refuses to load under the host's
      # default Appium 2.x runtime. Select Node 22 + Appium 3 so the host
      # runtime matches the drivers the harness installs.
      - devicefarm-cli use node 22
      - devicefarm-cli use appium 3
      - node --version
      - appium --version

  pre_test:
    commands:
      - cd \$DEVICEFARM_TEST_PACKAGE_PATH
      - rm -rf node_modules package-lock.json 2>/dev/null || true
      - npm install --legacy-peer-deps 2>&1
      - echo "Decoding wdio config..."
      - echo "${WDIO_CONFIG_B64}" | base64 -d > tests/wdio.config.devicefarm.js
      - echo "${GROUP_GREP_B64:-}" | base64 -d > /tmp/qvacShardGrep.txt
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
          \"appium:derivedDataPath\": \"\${DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH:-}\", \\
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
EOF

# --- Test invocation ---
# iOS wraps wdio so the on-device crash reports (.ips) are pulled in the SAME
# phase, then re-exits with wdio's own code. This cannot live in post_test:
# Device Farm skips that phase when the test phase exits non-zero, i.e. exactly
# when a crash report is what we need. An abort() in the addon kills the app
# before Bare flushes its console buffer, so bare_console.log stops mid-test and
# Device Farm surfaces no iOS crash report of its own.
# `set +e` stays on so log collection can never rewrite a run's verdict.
if [ "$PLATFORM" = "iOS" ]; then
  cat <<'EOF'
      - |
        set +e
        export PATH="$HOME/.local/bin:$PATH"
        # Under sudo these make pymobiledevice3 chown its config and fail EPERM.
        unset SUDO_UID SUDO_GID
        # Installed already by the model pre-stage step; install it otherwise.
        if ! command -v pymobiledevice3 >/dev/null 2>&1; then
          python3 -m pip install --quiet pymobiledevice3==10.3.1 >/dev/null 2>&1 \
            || pip3 install --quiet pymobiledevice3==10.3.1 >/dev/null 2>&1 \
            || python3 -m pip install --quiet --break-system-packages pymobiledevice3==10.3.1 >/dev/null 2>&1 \
            || true
        fi
        # Snapshot the reports already on the phone. Device Farm reuses devices
        # and every addon shard is the same bundle id, so a leftover .ips from
        # an earlier job would otherwise be reported as this run's crash. Names
        # carry the crash time and are unique, so comparing names is exact —
        # unlike an mtime window, which cannot tell the two apart.
        BEFORE_DIR=$(mktemp -d)
        BEFORE_LIST=$(mktemp)
        pymobiledevice3 crash pull "$BEFORE_DIR" >/dev/null 2>&1
        find "$BEFORE_DIR" -type f -exec basename {} \; > "$BEFORE_LIST" 2>/dev/null
        rm -rf "$BEFORE_DIR"

        node node_modules/@wdio/cli/bin/wdio.js run tests/wdio.config.devicefarm.js
        WDIO_RC=$?

        CRASH_DIR="$DEVICEFARM_LOG_DIR/crash-reports"
        mkdir -p "$CRASH_DIR"
        if command -v pymobiledevice3 >/dev/null 2>&1; then
          pymobiledevice3 crash pull "$CRASH_DIR" >/dev/null 2>&1
        else
          echo "[crash] pymobiledevice3 unavailable - skipping crash-report pull"
        fi
        # Keep this app's reports that were not already there before wdio ran.
        find "$CRASH_DIR" -type f | while IFS= read -r f; do
          case "$(basename "$f")" in
            QvacAddonTester*) ;;
            *) rm -f "$f"; continue ;;
          esac
          if grep -Fxq "$(basename "$f")" "$BEFORE_LIST" 2>/dev/null; then rm -f "$f"; fi
        done
        rm -f "$BEFORE_LIST"
        find "$CRASH_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
        # Echo it inline too: Customer_Artifacts can be missed, this output can't.
        NEWEST=$(ls -t "$CRASH_DIR"/QvacAddonTester* 2>/dev/null | head -1)
        if [ -n "$NEWEST" ]; then
          echo "[CRASH_REPORT_START] $(basename "$NEWEST")"
          head -c 20000 "$NEWEST"
          echo ""
          echo "[CRASH_REPORT_END]"
        else
          echo "[crash] no new QvacAddonTester crash report from this run"
        fi
        exit $WDIO_RC
EOF
else
  cat <<'EOF'
      - node node_modules/@wdio/cli/bin/wdio.js run tests/wdio.config.devicefarm.js
EOF
fi

cat <<EOF

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
