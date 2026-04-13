#!/bin/bash

# ===========================================================================
# Download Bergamot (Firefox Translations) model for a language pair
#
# Models are fetched from the Firefox Remote Settings CDN — the same
# source Firefox itself uses for translation models.
#
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

# ---- Download from Firefox Remote Settings CDN ----

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
