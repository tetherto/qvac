#!/bin/bash

# ===========================================================================
# Download Bergamot (Firefox Translations) model for a language pair
#
# Models are fetched from:
#   1. Hyperdrive (if available for the pair)
#   2. Firefox Remote Settings CDN (fallback)
#
# Downloads models from Hyperdrive or Firefox Remote Settings CDN.
# For programmatic use, see lib/bergamot-model-fetcher.js
#
# Usage:
#   ./scripts/generate-bergamot-presigned-urls.sh [language-pair]
#
# Examples:
#   ./scripts/generate-bergamot-presigned-urls.sh enit
#   ./scripts/generate-bergamot-presigned-urls.sh enfr
#
# Environment variables:
#   BERGAMOT_LANG_PAIR    - Language pair (alternative to argument)
#   FIREFOX_MODELS_DIR    - Destination directory (default: ~/.local/share/bergamot/models/firefox/base-memory)
# ===========================================================================

set -e

# Get language pair from argument or environment
LANG_PAIR="${1:-$BERGAMOT_LANG_PAIR}"

if [ -z "$LANG_PAIR" ]; then
    echo "❌ No language pair specified!"
    echo "Usage: $0 [language-pair]"
    echo "Example: $0 enit"
    echo "Or set BERGAMOT_LANG_PAIR environment variable"
    exit 1
fi

# Validate pair length
if [ ${#LANG_PAIR} -ne 4 ]; then
    echo "❌ Invalid language pair: '$LANG_PAIR' (expected 4 chars, e.g. 'enit')"
    exit 1
fi

SRC_LANG="${LANG_PAIR:0:2}"
DST_LANG="${LANG_PAIR:2:2}"

echo "=========================================="
echo "  Bergamot Model Download"
echo "  Pair: ${SRC_LANG} → ${DST_LANG}"
echo "=========================================="
echo ""

# Destination directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_MODELS_DIR="$HOME/.local/share/bergamot/models/firefox/base-memory"
MODELS_DIR="${FIREFOX_MODELS_DIR:-$DEFAULT_MODELS_DIR}"
DEST_DIR="$MODELS_DIR/$LANG_PAIR"

mkdir -p "$DEST_DIR"

echo "Destination: $DEST_DIR"
echo ""

# ---- Hyperdrive keys (from README.md Model Registry) ----
# Uses a function instead of associative array for bash 3.2 (macOS) compatibility
get_hd_key() {
    case "$1" in
        aren) echo "152125b9e579de7897bffddc2756a712f1c8e6fcbda162d1a821aab135c8ad7e" ;;
        csen) echo "41df2dadab7db9a8258d1520ae5815601f5690e0d96ab1e61f931427a679d32d" ;;
        enar) echo "c9ae647365e18d8c51eb21c47721544ee3daaaec375913e5ccb7a8d11d493a0c" ;;
        encs) echo "c7ccfc55618925351f32b00265375c66309240af9e90f0baf7f460ebc5ba34de" ;;
        enes) echo "bf46f9b51d04f5619eea1988499d81cd65268d9b0a60bea0fb647859ffe98a3c" ;;
        enfr) echo "0a4f388c0449b7774043e5ba8a1a2f735dc22a0a8e01d8bcd593e28db2909abf" ;;
        enit) echo "a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6" ;;
        enja) echo "ac0b883d176ea3b1d304790efe2d4e4e640a474b7796244c92496fb9d660f29d" ;;
        enpt) echo "21f12262b8b0440b814f2e57e8224d0921c6cf09e1da0238a4e83789b57ab34f" ;;
        enru) echo "404279d9716f31913cdb385bef81e940019134b577ed64ae3333b80da75a80bf" ;;
        enzh) echo "15d484200acea8b19b7eeffd5a96b218c3c437afbed61bfef39dafbae6edfec0" ;;
        esen) echo "c3e983c8db3f64faeef8eaf1da9ea4aeb8d5c020529f83957d63c19ed7710651" ;;
        fren) echo "7a9b38b0c4637b2eab9c11387b8c3f254db64da47cc5a7eecda66513176f7757" ;;
        iten) echo "3b4be93d19dd9e9e6ee38b528684028ac03c7776563bc0e5ca668b76b0964480" ;;
        jaen) echo "85012ed3c3ff5c2bfe49faa60ebafb86306e6f2a97f49796374d3069f505bfd3" ;;
        pten) echo "a5da4ee5f5817033dee6ed4489d1d3cadcf3d61e99fd246da7e0143c4b7439a4" ;;
        ruen) echo "dad7f99c8d8c17233bcfa005f789a0df29bb4ae3116381bdb2a63ffc32c97dfe" ;;
        zhen) echo "17eb4c3fcd23ac3c93cbe62f08ecb81d70f561f563870ea42494214d6886dd66" ;;
        *) echo "" ;;
    esac
}

HD_KEY="$(get_hd_key "$LANG_PAIR")"

if [ -n "$HD_KEY" ]; then
    echo "✓ Hyperdrive key found: ${HD_KEY:0:16}..."
    echo ""
    echo "To download via Bare / HyperdriveDL:"
    echo "  bare -e \"const HD = require('@qvac/dl-hyperdrive'); const d = new HD({ key: 'hd://$HD_KEY' }); ...\""
    echo ""
    echo "Or use the JS helper from the repo:"
    echo "  const { ensureBergamotModelFiles } = require('./lib/bergamot-model-fetcher')"
    echo "  await ensureBergamotModelFiles('$SRC_LANG', '$DST_LANG', '$DEST_DIR')"
    echo ""
fi

# ---- Fallback: download from Firefox Remote Settings CDN ----

echo "📥 Downloading from Firefox Remote Settings CDN..."
echo ""

RECORDS_URL="https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records"
ATTACHMENT_BASE="https://firefox-settings-attachments.cdn.mozilla.net"

# Fetch model records
echo "Fetching model index from Mozilla..."
RECORDS=$(curl -sS "$RECORDS_URL")

if [ -z "$RECORDS" ]; then
    echo "❌ Failed to fetch model records from Firefox Remote Settings"
    exit 1
fi

# Extract attachment URLs for this language pair using Python (available everywhere)
URLS=$(echo "$RECORDS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
records = data.get('data', [])
for r in records:
    if r.get('fromLang') == '$SRC_LANG' and r.get('toLang') == '$DST_LANG':
        att = r.get('attachment', {})
        loc = att.get('location', '')
        name = r.get('name', '') or att.get('filename', '')
        if loc and name:
            print(f'{name}|{loc}')
" 2>/dev/null)

if [ -z "$URLS" ]; then
    echo "❌ No Firefox model found for ${SRC_LANG}-${DST_LANG}"
    echo "Check https://github.com/mozilla/firefox-translations-models for supported pairs"
    exit 1
fi

# Download each file
while IFS='|' read -r FILENAME LOCATION; do
    URL="$ATTACHMENT_BASE/$LOCATION"
    DEST_FILE="$DEST_DIR/$FILENAME"

    echo "  Downloading $FILENAME..."
    curl -sS -L -o "$DEST_FILE" "$URL"

    if [ -f "$DEST_FILE" ]; then
        SIZE=$(du -h "$DEST_FILE" | cut -f1)
        echo "  ✓ $FILENAME ($SIZE)"
    else
        echo "  ❌ Failed to download $FILENAME"
    fi
done <<< "$URLS"

echo ""
echo "=========================================="
echo "✅ Model downloaded to: $DEST_DIR"
echo "=========================================="
echo ""
echo "Files:"
ls -lh "$DEST_DIR"
echo ""

# Export for CI (GitHub Actions)
if [ -n "$GITHUB_ENV" ]; then
    echo "BERGAMOT_MODEL_PATH=${DEST_DIR}" >> "$GITHUB_ENV"
    echo "✅ BERGAMOT_MODEL_PATH exported to GITHUB_ENV"

    # Also export individual file URLs for mobile test workflows
    # (backward compat with workflows expecting BERGAMOT_MODEL_URL / BERGAMOT_VOCAB_URL)
    MODEL_URL=""
    VOCAB_URL=""
    while IFS='|' read -r FILENAME LOCATION; do
        FILE_URL="${ATTACHMENT_BASE}/${LOCATION}"
        case "$FILENAME" in
            *.bin|*model*) [ -z "$MODEL_URL" ] && MODEL_URL="$FILE_URL" ;;
            *.spm|*vocab*) [ -z "$VOCAB_URL" ] && VOCAB_URL="$FILE_URL" ;;
        esac
    done <<< "$URLS"

    if [ -n "$MODEL_URL" ]; then
        echo "BERGAMOT_MODEL_URL=${MODEL_URL}" >> "$GITHUB_ENV"
        echo "✅ BERGAMOT_MODEL_URL exported"
    fi
    if [ -n "$VOCAB_URL" ]; then
        echo "BERGAMOT_VOCAB_URL=${VOCAB_URL}" >> "$GITHUB_ENV"
        echo "✅ BERGAMOT_VOCAB_URL exported"
    fi
fi

echo "🎉 Ready to use Bergamot ${LANG_PAIR} model!"
