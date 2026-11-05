#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

scope="${QVAC_DEVICE_TEST_SCOPE:-smoke}"
profile="${QVAC_DEVICE_TEST_PROFILE:-aio}"
features="${QVAC_DEVICE_TEST_FEATURES:-}"
./gradlew :android-example:assembleDebug :android-example:assembleDebugAndroidTest \
  -PqvacProfile="$profile" "$@"

app_apk="android-example/build/outputs/apk/debug/android-example-debug.apk"
test_apk="android-example/build/outputs/apk/androidTest/debug/android-example-debug-androidTest.apk"

adb get-state >/dev/null
adb install -r "$app_apk"
adb install -r "$test_apk"

case "$scope" in
  smoke)
    runner_args=(-e notAnnotation androidx.test.filters.LargeTest)
    ;;
  full)
    runner_args=()
    ;;
  feature-lab)
    runner_args=(-e class io.tether.qvac.sdk.sample.FeatureLabInstrumentationTest)
    ;;
  *)
    echo "QVAC_DEVICE_TEST_SCOPE must be 'smoke', 'full', or 'feature-lab'" >&2
    exit 2
    ;;
esac

runner_args+=(-e qvacProfile "$profile")
if [[ -n "$features" ]]; then
  runner_args+=(-e qvacFeatures "$features")
fi

mkdir -p build/device-test-results
result_file="$(mktemp "$project_root/build/device-test-results/${profile}-${scope}.XXXXXX")"
# pipefail preserves adb/tee errors; the validator also catches the common
# Android failure mode where adb exits zero after failed tests or a crash.
adb shell am instrument -w -r "${runner_args[@]}" \
  io.tether.qvac.sdk.sample.test/androidx.test.runner.AndroidJUnitRunner | tee "$result_file"
python3 scripts/check_android_instrumentation.py "$result_file"
