#!/usr/bin/env bash
# Translation quality evaluation, as benchmark-translation-nmtcpp.yml ran it, for every requested pair on this host.
# Dispatch options arrive in BENCHMARK_ARGS as key=value words:
#   pairs=en-it,de-en  translators=qvac_bergamot,opusmt,google,nllb,bergamot,qvac
#   datasets=flores-devtest,conversational-phrases  metrics=chrfpp,comet  hyperparams=fast|default
#   pivot=true  batch=true  quantized=true
set -euo pipefail

PKG=$(cd "$(dirname "$0")/.." && pwd)
EVAL="$PKG/benchmarks/quality_eval"

pairs=en-it translators=qvac_bergamot datasets=flores-devtest metrics=chrfpp,comet hyperparams=fast
pivot=false batch=false quantized=false
for word in ${BENCHMARK_ARGS:-}; do
  key=${word%%=*} value=${word#*=}
  case "$key" in
    pairs) [[ "$value" =~ ^[a-z]{2,3}-[a-z]{2,3}(,[a-z]{2,3}-[a-z]{2,3})*$ ]] || { echo "::error::pairs '$value' is not like en-it,de-en"; exit 1; } ;;
    translators) [[ "$value" =~ ^(qvac_bergamot|opusmt|google|nllb|bergamot|qvac)(,(qvac_bergamot|opusmt|google|nllb|bergamot|qvac))*$ ]] || { echo "::error::unknown translators '$value'"; exit 1; } ;;
    datasets) [[ "$value" =~ ^(flores-devtest|conversational-phrases)(,(flores-devtest|conversational-phrases))?$ ]] || { echo "::error::unknown datasets '$value'"; exit 1; } ;;
    metrics) [[ "$value" =~ ^(chrfpp|comet)(,(chrfpp|comet))?$ ]] || { echo "::error::unknown metrics '$value'"; exit 1; } ;;
    hyperparams) [[ "$value" =~ ^(fast|default)$ ]] || { echo "::error::hyperparams is fast or default"; exit 1; } ;;
    pivot | batch | quantized) [[ "$value" =~ ^(true|false)$ ]] || { echo "::error::$key is true or false"; exit 1; } ;;
    *) echo "::error::unknown BENCHMARK_ARGS word '$word'"; exit 1 ;;
  esac
  declare "$key=$value"
done

# Named as main's hosts, which summarize-nmt-quality.js reads from the results directory names.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  Darwin-arm64) platform=macos-arm64 ;;
  MINGW*-x86_64 | MSYS*-x86_64) platform=windows-x64 ;;
  *) echo "::error::no benchmark host for $(uname -s)-$(uname -m)"; exit 1 ;;
esac
# Only the addon's own translators run off the Linux host.
if [ "$platform" != linux-x64 ] && [[ ",$translators," =~ ,(opusmt|google|nllb|bergamot), ]]; then
  echo "::error::translators other than qvac and qvac_bergamot run on linux-x64 only"; exit 1
fi
hosted=false; [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && hosted=true

if [ "$platform" = linux-x64 ] && $hosted; then
  sudo apt-get update
  sudo apt-get install -y cmake wget build-essential libprotobuf-dev protobuf-compiler libboost-all-dev ccache libunwind-dev
  sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL
fi

venv=$(mktemp -d)/venv
py=python3; command -v python3 >/dev/null 2>&1 || py=python
"$py" -m venv "$venv"
PYBIN="$venv/bin/python"; [ -x "$PYBIN" ] || PYBIN="$venv/Scripts/python.exe"
"$PYBIN" -m pip install --upgrade pip
if $hosted; then
  (cd "$EVAL" && "$PYBIN" -m pip install -r requirements.txt)
else
  (cd "$EVAL" && "$PYBIN" -m pip install -r requirements-qvac.txt)
  if [[ ",$metrics," == *,comet,* ]]; then "$PYBIN" -m pip install "unbabel-comet>=2.2.6"; fi
fi
# Python's subprocess on Windows cannot resolve the extension-less shim.
export BARE_BIN="$PKG/node_modules/.bin/bare"
[ "$platform" = windows-x64 ] && BARE_BIN="$BARE_BIN.cmd"

# The qvac translator's GGML Marian models, from S3; a miss falls back to Hyperdrive in evaluate.py.
download_model() {
  local model_pair=$1 s3_pair=$1 kind=q0f16 name=model_f16.bin
  [ "$model_pair" = en-pt ] && s3_pair=en-roa
  [ "$model_pair" = pt-en ] && s3_pair=roa-en
  if [ "$quantized" = true ]; then kind=q4_0 name=model_q4_0.bin; fi
  local temp="$PKG/qvac_models/temp_$model_pair"
  mkdir -p "$temp"
  if ! aws s3 cp "s3://$MODEL_S3_BUCKET/qvac_models_compiled/ggml/marian/$kind/ggml-opus-$s3_pair/" "$temp/" --recursive --only-show-errors; then
    echo "::warning::no S3 model for $model_pair; evaluate.py falls back to Hyperdrive"
    rm -rf "$temp"; return 0
  fi
  local dest="$PKG/qvac_models/$model_pair" dated
  mkdir -p "$dest"
  dated=$(find "$temp" -mindepth 1 -maxdepth 1 -type d | sort -r | head -1)
  mv "${dated:-$temp}"/* "$dest/"
  rm -rf "$temp"
  for f in "ggml-opus-$s3_pair.bin" "ggml-opus-$model_pair.bin"; do
    if [ -f "$dest/$f" ]; then mv "$dest/$f" "$dest/$name"; break; fi
  done
}

# The bergamot translator's Firefox models, from GitHub LFS.
firefox_models() {
  local code=$1 repo
  repo=$(mktemp -d)/firefox-translations-models
  sudo apt-get install -y git-lfs && git lfs install
  git clone --depth 1 https://github.com/mozilla/firefox-translations-models.git "$repo"
  (cd "$repo" && git lfs pull --include="models/base-memory/$code/*" && cd "models/base-memory/$code" && gunzip -k ./*.gz)
  mkdir -p "$HOME/.local/share/bergamot/models/firefox/base-memory/$code"
  cp -v "$repo/models/base-memory/$code/"*.bin "$repo/models/base-memory/$code/"*.spm "$HOME/.local/share/bergamot/models/firefox/base-memory/$code/"
}

# The qvac_bergamot translator's models, from Firefox's Remote Settings CDN.
cdn_models() {
  local src=$1 trg=$2 dest urls
  dest="$HOME/.local/share/bergamot/models/firefox/base-memory/$src$trg"
  mkdir -p "$dest"
  urls=$(curl -sS https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records |
    "$PYBIN" -c "
import sys, json
for r in json.load(sys.stdin).get('data', []):
    if r.get('fromLang') == '$src' and r.get('toLang') == '$trg':
        att = r.get('attachment', {})
        name = r.get('name', '') or att.get('filename', '')
        if att.get('location') and name:
            print(name + '|' + att['location'])
")
  [ -n "$urls" ] || { echo "::warning::no Firefox model for $src-$trg"; return 0; }
  while IFS='|' read -r file location; do
    curl -sS -L -o "$dest/$file" "https://firefox-settings-attachments.cdn.mozilla.net/$location"
  done <<<"$urls"
}

case "$hyperparams" in
  fast) set -- --beamsize 1 --lengthpenalty 1.0 --repetitionpenalty 1.2 --norepeatngramsize 3 ;;
  *) set -- --beamsize 4 --lengthpenalty 1.0 --repetitionpenalty 1.0 --norepeatngramsize 0 ;;
esac
set -- "$@" --temperature 1.0 --topk 0 --topp 1.0 --maxlength 512
[ "$pivot" = true ] && set -- "$@" --use-pivot
[ "$batch" = true ] && set -- "$@" --batch
[ "$quantized" = true ] && set -- "$@" --is-quantized-model

IFS=, read -ra PAIRS <<<"$pairs"
IFS=, read -ra DATASETS <<<"$datasets"
for pair in "${PAIRS[@]}"; do
  src=${pair%-*} trg=${pair#*-}
  # Model fetches are best effort, as main ran them: evaluate.py reports what it could not translate.
  if [[ ",$translators," == *,qvac,* ]]; then
    download_model "$pair"
    if [ "$pivot" = true ] && [ "$src" != en ] && [ "$trg" != en ]; then
      download_model "$src-en"; download_model "en-$trg"
    fi
  fi
  if [[ ",$translators," == *,bergamot,* ]]; then firefox_models "$src$trg" || echo "::warning::Firefox models for $pair failed"; fi
  if [[ ",$translators," == *,qvac_bergamot,* ]]; then cdn_models "$src" "$trg" || echo "::warning::CDN models for $pair failed"; fi
  # An if, not $([ ... ] && echo): a false test there fails the assignment under set -e.
  suffix=""; if [ "$pivot" = true ]; then suffix=-pivot; fi
  results="$PKG/benchmarks/results/results-$pair-$translators-$metrics-$hyperparams$suffix-$platform"
  for dataset in "${DATASETS[@]}"; do
    echo "== $pair on $dataset"
    (cd "$EVAL" && PYTHONUNBUFFERED=1 "$PYBIN" evaluate.py --pairs "$pair" --translators "$translators" --dataset "$dataset" \
      --metrics "$metrics" --results-dir "$results" --data-dir data --no-skip-existing "$@")
  done
done
