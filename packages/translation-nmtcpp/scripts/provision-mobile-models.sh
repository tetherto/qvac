#!/usr/bin/env bash
set -euo pipefail

# provision-mobile-models.sh
# Generates model URLs for Bergamot (Firefox CDN) and IndicTrans (S3 presigned),
# then bundles them into test/mobile/testAssets/ for the mobile test app.
#
# Required env:
#   BERGAMOT_LANG_PAIR    e.g. "enit"
#   MODEL_S3_BUCKET       S3 bucket for IndicTrans models
#   AWS_REGION            AWS region for IndicTrans (default: eu-central-1)
#
# Must run AFTER aws-actions/configure-aws-credentials.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSETS_DIR="test/mobile/testAssets"
mkdir -p "$ASSETS_DIR"

# ── 1. Bergamot (Firefox CDN) ───────────────────────────────────────
LANG_PAIR="${BERGAMOT_LANG_PAIR:-enit}"
SRC="${LANG_PAIR:0:2}"
DST="${LANG_PAIR:2:2}"

echo "── Bergamot: fetching model URLs for ${SRC}→${DST} ──"

CDN_INDEX="https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records"
CDN_BASE="https://firefox-settings-attachments.cdn.mozilla.net"

RECORDS=$(curl -sS "$CDN_INDEX")

read -r MODEL_URL VOCAB_URL < <(
  echo "$RECORDS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
m = v = ''
for r in data.get('data', []):
    if r.get('fromLang') == '${SRC}' and r.get('toLang') == '${DST}':
        att = r.get('attachment', {})
        loc, name = att.get('location', ''), r.get('name', '') or att.get('filename', '')
        if loc and name:
            url = '${CDN_BASE}/' + loc
            if not m and (name.endswith('.bin') or 'model' in name.lower()): m = url
            elif not v and (name.endswith('.spm') or 'vocab' in name.lower()): v = url
print(m, v)
")

if [ -n "$MODEL_URL" ] && [ -n "$VOCAB_URL" ]; then
  printf '{\n  "modelUrl": "%s",\n  "vocabUrl": "%s"\n}\n' "$MODEL_URL" "$VOCAB_URL" \
    > "$ASSETS_DIR/bergamot-urls.json"
  echo "  ✅ bergamot-urls.json written"
else
  echo "  ⚠️  Bergamot URLs not found for ${LANG_PAIR}"
fi

# ── 2. IndicTrans (S3 presigned) ────────────────────────────────────
echo ""
echo "── IndicTrans: generating presigned URL ──"

chmod +x "$SCRIPT_DIR/generate-indictrans-presigned-urls.sh"
"$SCRIPT_DIR/generate-indictrans-presigned-urls.sh"

# The sub-script writes INDICTRANS_MODEL_URL to $GITHUB_ENV; read it
# back so we can bundle in this same shell invocation.
INDICTRANS_URL=$(grep '^INDICTRANS_MODEL_URL=' "${GITHUB_ENV:-/dev/null}" 2>/dev/null \
  | tail -1 | cut -d= -f2- || true)

if [ -n "$INDICTRANS_URL" ]; then
  printf '{\n  "modelUrl": "%s"\n}\n' "$INDICTRANS_URL" \
    > "$ASSETS_DIR/indictrans-model-urls.json"
  echo "  ✅ indictrans-model-urls.json written"
else
  echo "  ⚠️  IndicTrans URL not generated"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "── testAssets ──"
ls -la "$ASSETS_DIR/"
