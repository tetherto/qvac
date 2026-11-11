#!/usr/bin/env bash
# asr's accuracy benchmark (WER/CER, AraDiaWER for Arabic), as main's asr accuracy workflow ran it: every row of
# ci/accuracy-matrix.py in turn on this host, each against the benchmark server, into benchmarks/results. The BM_*
# variables carry the dispatch options; a failed row fails the run after the others have run.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PKG="$PWD"
STREAMING_CHUNK_SIZE=64000

if [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]; then
  sudo docker image prune --all --force || true
  sudo rm -rf /opt/hostedtoolcache/CodeQL /opt/ghc /usr/share/dotnet /usr/local/lib/android
  sudo apt-get clean
fi
sudo apt-get update && sudo apt-get install -y ffmpeg build-essential cmake unzip curl || exit 1
if ! command -v poetry > /dev/null; then
  curl -sSL https://install.python-poetry.org | python3 - || exit 1
  export PATH="$HOME/.local/bin:$PATH"
fi

ROWS=$(ENGINE="$BM_ENGINE" LANGUAGE="$BM_LANGUAGE" DATASET="$BM_DATASET" MODEL_SIZE="$BM_MODEL_SIZE" \
  MODEL_TYPE="$BM_MODEL_TYPE" CUSTOM_MODEL_REPO="$BM_CUSTOM_MODEL_REPO" MAX_SAMPLES="$BM_MAX_SAMPLES" \
  python3 ci/accuracy-matrix.py) || exit 1

(cd benchmarks/server && npm install && npm install ../../) || exit 1
(cd benchmarks/client && poetry install --no-cache) || exit 1

summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$1" >> "$GITHUB_STEP_SUMMARY"; echo "$1"; }
field() { grep "$1" "$2" | head -1 | sed "s/.*$1 //" | sed 's/\*\*//'; }

# Main's whisper model and dataset staging, config patching and timeouts for one row.
prepare_whisper() {
  local row="$1" model_file source url lang
  model_file=$(jq -r .model_file <<< "$row")
  source=$(jq -r .source <<< "$row")
  mkdir -p examples
  if [ -n "$BM_CUSTOM_MODEL_REPO" ]; then
    rm -rf /tmp/custom-model /tmp/custom-model-ggml
    git clone "$BM_CUSTOM_MODEL_REPO" /tmp/custom-model || return 1
    pip install -r benchmarks/ci/requirements-conversion.txt || return 1
    local whisper_parent ggml
    whisper_parent=$(dirname "$(python -c "import whisper, os; print(os.path.dirname(whisper.__file__))")")
    python benchmarks/ci/convert-hf-to-ggml.py /tmp/custom-model "$whisper_parent" /tmp/custom-model-ggml || return 1
    ggml=$(find /tmp/custom-model-ggml -name ggml-model.bin -type f | head -n 1)
    [ -n "$ggml" ] || { echo "ggml-model.bin not found in /tmp/custom-model-ggml"; return 1; }
    model_file="custom-$(basename "$BM_CUSTOM_MODEL_REPO")-$(jq -r .model_variant <<< "$row").bin"
    cp "$ggml" "examples/$model_file"
  elif [ ! -f "examples/$model_file" ]; then
    url=$([ "$source" = futo ] && jq -r .download_url <<< "$row" || echo "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$model_file")
    wget "$url" -O "examples/$model_file" || return 1
  fi
  MODEL_NAME="${model_file%.bin}"
  DATASET_LANGUAGE="$BM_LANGUAGE"
  case "$BM_DATASET" in
    arabic_levantine) CONFIG_FILE=config-whisper-arabic-levantine.yaml; DATASET_LANGUAGE=arabic ;;
    arabic_egyptian) CONFIG_FILE=config-whisper-arabic-egyptian.yaml; DATASET_LANGUAGE=arabic ;;
    arabic_validated_all) CONFIG_FILE=config-whisper-arabic.yaml; DATASET_LANGUAGE=arabic ;;
    *) CONFIG_FILE=config-whisper.yaml ;;
  esac
  if [ "$DATASET_LANGUAGE" = arabic ]; then
    mkdir -p "benchmarks/data/samples/$BM_DATASET"
    aws s3 sync "s3://$MODEL_S3_BUCKET/qvac_datasets/transcription/arabic/$BM_DATASET/" "benchmarks/data/samples/$BM_DATASET/" --quiet || return 1
    [ -f "benchmarks/data/samples/$BM_DATASET/manifest.json" ] || { echo "manifest.json not found after S3 download"; return 1; }
  fi
  local max timeout
  if [ "$BM_MAX_SAMPLES" != "-1" ]; then max="$BM_MAX_SAMPLES"; else
    case "$BM_MODEL_SIZE" in small) max=1000 ;; medium) max=100 ;; *) max=0 ;; esac
  fi
  case "$BM_MODEL_SIZE" in base) timeout=100 ;; small) timeout=200 ;; medium) timeout=1000 ;; *) timeout=40 ;; esac
  [ "$BM_STREAMING_MODE" = true ] && timeout=$((timeout * 2))
  case "$DATASET_LANGUAGE" in
    french) lang=fr ;; german) lang=de ;; spanish) lang=es ;; italian) lang=it ;; portuguese) lang=pt ;;
    mandarin_chinese) lang=zh ;; arabic) lang="ar" ;; russian) lang=ru ;; japanese) lang=ja ;; czech) lang=cs ;; *) lang="" ;;
  esac
  [ "$(jq -r .language <<< "$row")" = en ] && lang=en
  local cfg="benchmarks/client/config/$CONFIG_FILE"
  sed -i "s|timeout:.*|timeout: ${timeout}|" "$cfg"
  sed -i "s|path:.*|path: \"$PKG/examples/$model_file\"|" "$cfg"
  sed -i "s|speaker_group:.*|speaker_group: \"clean\"|" "$cfg"
  if [ "$DATASET_LANGUAGE" = arabic ]; then
    sed -i "s|common_voice_manifest:.*|common_voice_manifest: \"$PKG/benchmarks/data/samples/$BM_DATASET/manifest.json\"|" "$cfg"
    DATASET_TYPE=common_voice
  else
    sed -i "/^dataset:/,/^[^ ]/ s|  dataset_type:.*|  dataset_type: \"$BM_DATASET\"|" "$cfg"
    DATASET_TYPE="$BM_DATASET"
  fi
  sed -i "/^dataset:/,/^[^ ]/ s|  language:.*|  language: \"$DATASET_LANGUAGE\"|" "$cfg"
  sed -i "/^dataset:/,/^[^ ]/ s|  max_samples:.*|  max_samples: $max|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  language:.*|  language: \"$lang\"|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  vad:.*|  vad: false|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  vad_model_path:.*|  vad_model_path: \"\"|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  streaming:.*|  streaming: $BM_STREAMING_MODE|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  streaming_chunk_size:.*|  streaming_chunk_size: $STREAMING_CHUNK_SIZE|" "$cfg"
  local mode=batch
  [ "$BM_STREAMING_MODE" = true ] && mode=streaming
  RESULT_FILE="benchmarks/results/$MODEL_NAME/$DATASET_TYPE-$DATASET_LANGUAGE-clean-$MODEL_NAME-no_vad-$mode.md"
  TITLE="$(jq -r .model_variant <<< "$row") ($mode)"
}

# Main's parakeet staging (the manifest's GGUF, which the job fetched for this target) and config patching.
prepare_parakeet() {
  local row="$1" gguf type s3 timeout
  gguf=$(jq -r .gguf <<< "$row")
  type=$(jq -r .model_type <<< "$row")
  if [ ! -f "models/$gguf" ]; then
    s3=$(jq -r --arg f "$gguf" '.models[$f].s3Path // empty' test/integration/models.manifest.json)
    [ -n "$s3" ] || { echo "::error::GGUF '$gguf' not declared in test/integration/models.manifest.json"; return 1; }
    mkdir -p models && aws s3 cp "s3://$MODEL_S3_BUCKET/$s3" models/ || return 1
  fi
  case "$type" in
    unified) CONFIG_FILE=config-parakeet-unified.yaml ;; ctc) CONFIG_FILE=config-parakeet-ctc.yaml ;;
    eou) CONFIG_FILE=config-parakeet-eou.yaml ;; sortformer) CONFIG_FILE=config-parakeet-sortformer.yaml ;;
    indic-conformer) CONFIG_FILE=config-parakeet-indic-conformer.yaml ;; *) CONFIG_FILE=config-parakeet.yaml ;;
  esac
  case "$type" in ctc) timeout=60 ;; sortformer) timeout=180 ;; *) timeout=120 ;; esac
  local streaming gpu
  streaming=$(jq -r .streaming <<< "$row")
  gpu=$(jq -r .use_gpu <<< "$row")
  [ "$streaming" = true ] && timeout=$((timeout * 4))
  local cfg="benchmarks/client/config/$CONFIG_FILE"
  sed -i "s|timeout:.*|timeout: ${timeout}|" "$cfg"
  sed -i "s|path:.*|path: \"$PKG/models/$gguf\"|" "$cfg"
  sed -i "s|speaker_group:.*|speaker_group: \"clean\"|" "$cfg"
  sed -i "/^dataset:/,/^[^ ]/ s|  dataset_type:.*|  dataset_type: \"$(jq -r .dataset_type <<< "$row")\"|" "$cfg"
  sed -i "/^dataset:/,/^[^ ]/ s|  language:.*|  language: \"$(jq -r .language <<< "$row")\"|" "$cfg"
  sed -i "/^dataset:/,/^[^ ]/ s|  max_samples:.*|  max_samples: $(jq -r .max_samples <<< "$row")|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  model_type:.*|  model_type: \"$type\"|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  language:.*|  language: \"$(jq -r .model_language <<< "$row")\"|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  use_gpu:.*|  use_gpu: $gpu|" "$cfg"
  sed -i "/^model:/,/^[^ ]/ s|  streaming:.*|  streaming: $streaming|" "$cfg"
  local g=cpu m=batch
  [ "$gpu" = true ] && g=gpu
  [ "$streaming" = true ] && m=streaming
  RESULT_FILE="benchmarks/results/$gguf/$(jq -r .dataset_type <<< "$row")-$(jq -r .language <<< "$row")-clean-$type-$g-$m.md"
  TITLE="$(jq -r .model_variant <<< "$row")"
}

failed=0
while read -r row; do
  echo "=== $(jq -r .model_variant <<< "$row") ==="
  if [ "$(jq -r .engine <<< "$row")" = whisper ]; then prepare_whisper "$row"; else prepare_parakeet "$row"; fi || { failed=1; continue; }
  (cd benchmarks/server && { nohup npm start > server.log 2>&1 & echo $! > server.pid; })
  sleep 5
  if kill -0 "$(cat benchmarks/server/server.pid)" 2> /dev/null; then
    mkdir -p benchmarks/data/tmp
    (cd benchmarks/client && PYTHONUNBUFFERED=1 HF_DATASETS_CACHE=/tmp/hf_cache TMPDIR="$PKG/benchmarks/data/tmp" \
      poetry run python -u -m src.main --config "config/$CONFIG_FILE") || failed=1
    rm -rf /tmp/hf_cache
  else
    echo "Server failed to start"
    failed=1
  fi
  kill "$(cat benchmarks/server/server.pid)" 2> /dev/null || true
  rm -f benchmarks/server/server.pid
  cat benchmarks/server/server.log 2> /dev/null
  summary "### $TITLE"
  if [ -f "$RESULT_FILE" ]; then
    summary "| Metric | Value |"
    summary "|--------|-------|"
    summary "| Samples | $(field 'Samples evaluated:' "$RESULT_FILE") |"
    summary "| WER | $(field 'WER:' "$RESULT_FILE") |"
    summary "| CER | $(field 'CER:' "$RESULT_FILE") |"
    if grep -q 'AraDiaWER:' "$RESULT_FILE"; then summary "| AraDiaWER | $(field 'AraDiaWER:' "$RESULT_FILE") |"; fi
    summary "| Load time | $(field 'Total load time:' "$RESULT_FILE") |"
    summary "| Run time | $(field 'Total run time:' "$RESULT_FILE") |"
  else
    summary "Results file not found: $RESULT_FILE"
    failed=1
  fi
done < <(jq -c '.[]' <<< "$ROWS")
exit "$failed"
