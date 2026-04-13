/**
 * Mobile init hook for pre-cached models on Device Farm.
 *
 * When cache-models is enabled in CI, the Device Farm host downloads
 * models from S3 and pushes them to /data/local/tmp/qvac-models/ via adb.
 * The consumer's bootstrap() copies them into the app's own cache directory
 * (bypassing SELinux write restrictions on /data/local/tmp/) and writes
 * qvac.config.json so the SDK uses the pre-cached files.
 *
 * Referenced from qvac-test.config.js as mobileInit.
 */

export const __sdkPreload = true;
