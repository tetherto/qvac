#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERF_DIR="${ROOT_DIR}/benchmark-perf"

PARAMS="all"
REPS="3"
CONFIG="${PERF_DIR}/perf-config.json"
RUN_JUDGE="false"
RUN_ANALYSIS="false"
ADDON=""
HF_TOKEN="${HF_TOKEN:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --params)
      PARAMS="$2"
      shift 2
      ;;
    --reps)
      REPS="$2"
      shift 2
      ;;
    --config)
      CONFIG="$2"
      shift 2
      ;;
    --judge)
      RUN_JUDGE="true"
      shift 1
      ;;
    --addon)
      ADDON="$2"
      shift 2
      ;;
    --analyze)
      RUN_ANALYSIS="true"
      shift 1
      ;;
    --hf-token)
      HF_TOKEN="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ ! -d "${PERF_DIR}/node_modules" ]]; then
  echo "==> Installing perf dependencies"
  (cd "${PERF_DIR}" && npm install)
fi

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "==> Installing addon dependencies"
  (cd "${ROOT_DIR}" && npm install)
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required but was not found on PATH."
  exit 1
fi

VENV_DIR="${PERF_DIR}/.venv"
if [[ ! -d "${VENV_DIR}" ]]; then
  echo "==> Creating Python venv"
  python3 -m venv "${VENV_DIR}"
fi

VENV_PY="${VENV_DIR}/bin/python"
if ! "${VENV_PY}" -c "import psutil" >/dev/null 2>&1; then
  echo "==> Installing Python deps"
  "${VENV_PY}" -m pip install -r "${PERF_DIR}/requirements.txt"
fi
if [[ "${RUN_ANALYSIS}" == "true" ]]; then
  if ! "${VENV_PY}" -c "import pandas, matplotlib, seaborn, sklearn" >/dev/null 2>&1; then
    echo "==> Installing analysis deps"
    "${VENV_PY}" -m pip install -r "${PERF_DIR}/analysis/requirements.txt"
  fi
fi

echo "==> Running QVAC perf"
if [[ -n "${HF_TOKEN}" ]]; then
  export HF_TOKEN
fi
bare "${PERF_DIR}/qvac-perf.js" --config "${CONFIG}" --params "${PARAMS}" --reps "${REPS}" ${ADDON:+--addon "${ADDON}"}

echo "==> Running PyTorch perf"
"${VENV_PY}" "${PERF_DIR}/pytorch-perf.py" --config "${CONFIG}" --params "${PARAMS}" --reps "${REPS}" ${HF_TOKEN:+--hf-token "${HF_TOKEN}"}

if [[ "${RUN_JUDGE}" == "true" ]]; then
  echo "==> Running judge"
  for file in "${PERF_DIR}"/results/qvac_*.jsonl; do
    [[ -e "$file" ]] || continue
    bare "${PERF_DIR}/judge.js" --config "${CONFIG}" --input "$file"
  done
fi

if [[ "${RUN_ANALYSIS}" == "true" ]]; then
  echo "==> Running analysis"
  "${VENV_PY}" "${PERF_DIR}/analysis/analyze.py" --input "${PERF_DIR}/results" --output "${PERF_DIR}/analysis/plots"
fi
