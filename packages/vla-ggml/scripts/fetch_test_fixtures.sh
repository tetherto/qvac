#!/bin/bash
# Fetch the pinned π₀.₅ parity-oracle dump (fixture + activations).
#
# The .safetensors artefacts are gitignored — they're large (~hundreds of MB
# at float32) and reproducible from `dump_pi05_activations.py`. This script
# resolves the canonical copy in one of three ways:
#
#   1. If $PI05_ORACLE_URL_BASE is set, fetch fixture.safetensors and
#      activations.safetensors from `<base>/<sha256>/...`.
#   2. Else if the local files already exist and their sha256s match
#      oracle_fixtures.json, exit 0 (cache hit).
#   3. Else print the regeneration command and exit non-zero.
#
# The SHA-256s in oracle_fixtures.json are the contract — if a download is
# corrupt or the regeneration produced a different bit pattern, this script
# exits non-zero and refuses to populate the cache.

set -eu

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FIXTURES_JSON="${SCRIPT_DIR}/oracle_fixtures.json"
OUT_DIR="${SCRIPT_DIR}/oracle_dump"
FIXTURE_PATH="${OUT_DIR}/fixture.safetensors"
ACTIVATIONS_PATH="${OUT_DIR}/activations.safetensors"

if [ ! -f "${FIXTURES_JSON}" ]; then
    echo "❌ ${FIXTURES_JSON} is missing — run dump_pi05_activations.py first."
    exit 1
fi

FIXTURE_SHA=$(python3 -c "import json,sys; print(json.load(open('${FIXTURES_JSON}'))['fixture_sha256'])")
ACTIVATIONS_SHA=$(python3 -c "import json,sys; print(json.load(open('${FIXTURES_JSON}'))['activations_sha256'])")

if [ -z "${FIXTURE_SHA}" ] || [ "${FIXTURE_SHA}" = "null" ]; then
    echo "❌ fixture_sha256 not populated in ${FIXTURES_JSON} — has the oracle ever been run?"
    echo "   See packages/vla-ggml/scripts/README-oracle.md for instructions."
    exit 1
fi

mkdir -p "${OUT_DIR}"

verify_sha() {
    local path="$1"
    local want="$2"
    if [ ! -f "${path}" ]; then return 1; fi
    local got
    got=$(sha256sum "${path}" | awk '{print $1}')
    if [ "${got}" = "${want}" ]; then return 0; else return 2; fi
}

# Cache hit?
if verify_sha "${FIXTURE_PATH}" "${FIXTURE_SHA}" && verify_sha "${ACTIVATIONS_PATH}" "${ACTIVATIONS_SHA}"; then
    echo "✅ oracle dump already present and matches oracle_fixtures.json"
    exit 0
fi

# Remote fetch path.
if [ -n "${PI05_ORACLE_URL_BASE:-}" ]; then
    echo "📥 fetching from ${PI05_ORACLE_URL_BASE}/${FIXTURE_SHA}/ ..."
    curl -fSL -o "${FIXTURE_PATH}" "${PI05_ORACLE_URL_BASE}/${FIXTURE_SHA}/fixture.safetensors"
    curl -fSL -o "${ACTIVATIONS_PATH}" "${PI05_ORACLE_URL_BASE}/${ACTIVATIONS_SHA}/activations.safetensors"

    if ! verify_sha "${FIXTURE_PATH}" "${FIXTURE_SHA}"; then
        echo "❌ fetched fixture.safetensors sha256 mismatch"
        exit 1
    fi
    if ! verify_sha "${ACTIVATIONS_PATH}" "${ACTIVATIONS_SHA}"; then
        echo "❌ fetched activations.safetensors sha256 mismatch"
        exit 1
    fi
    echo "✅ oracle dump fetched and verified"
    exit 0
fi

echo "❌ oracle dump missing and PI05_ORACLE_URL_BASE not set."
echo ""
echo "Regenerate locally with:"
echo "  python3 ${SCRIPT_DIR}/dump_pi05_activations.py \\"
echo "    --checkpoint lerobot/pi05_base \\"
echo "    --out-dir   ${OUT_DIR}/ \\"
echo "    --seed      0"
echo ""
echo "Then re-run this script to verify against oracle_fixtures.json."
exit 1
