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
ADDON_MODULE=""
QUICK="false"
FAILURES=0

is_path_spec() {
  [[ "$1" == /* || "$1" == ./* || "$1" == ../* || "$1" == "~/"* ]]
}

normalize_addon_module() {
  local spec="$1"
  if is_path_spec "$spec"; then
    echo "$spec"
    return
  fi
  if [[ "$spec" == @*/*@* ]]; then
    echo "${spec%@*}"
    return
  fi
  if [[ "$spec" == *@* && "$spec" != @* ]]; then
    echo "${spec%@*}"
    return
  fi
  echo "$spec"
}

extract_addon_version() {
  local spec="$1"
  if [[ "$spec" == @*/*@* ]]; then
    echo "${spec##*@}"
    return
  fi
  if [[ "$spec" == *@* && "$spec" != @* ]]; then
    echo "${spec##*@}"
    return
  fi
  echo ""
}

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
    --quick)
      QUICK="true"
      shift 1
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "${ADDON_MODULE}" && -n "${ADDON}" ]]; then
  ADDON_MODULE="$(normalize_addon_module "${ADDON}")"
fi

if [[ ! -f "${PERF_DIR}/node_modules/bare-path/package.json" ]]; then
  echo "==> Installing perf dependencies"
  (cd "${PERF_DIR}" && npm install)
fi

if [[ -z "${ADDON}" || "${RUN_JUDGE}" == "true" ]]; then
  if [[ ! -f "${ROOT_DIR}/node_modules/bare-path/package.json" ]]; then
    echo "==> Installing addon dependencies"
    (cd "${ROOT_DIR}" && npm install)
  fi
fi

if [[ -n "${ADDON}" ]] && ! is_path_spec "${ADDON}"; then
  ADDON_VERSION="$(extract_addon_version "${ADDON}")"
  MODULE_PATH="${PERF_DIR}/node_modules/${ADDON_MODULE}/package.json"
  INSTALL_ADDON="false"
  if [[ ! -f "${MODULE_PATH}" ]]; then
    INSTALL_ADDON="true"
  elif [[ -n "${ADDON_VERSION}" ]]; then
    INSTALLED_VERSION="$(node -p "require('${MODULE_PATH}').version" 2>/dev/null || echo "")"
    if [[ "${INSTALLED_VERSION}" != "${ADDON_VERSION}" ]]; then
      INSTALL_ADDON="true"
    fi
  fi
  if [[ "${INSTALL_ADDON}" == "true" ]]; then
    echo "==> Installing addon package ${ADDON}"
    (cd "${PERF_DIR}" && npm install "${ADDON}")
  fi
fi

if [[ -z "${ADDON}" ]]; then
  if ! find "${ROOT_DIR}/prebuilds" -maxdepth 2 -type f -name "qvac__llm-llamacpp*" >/dev/null 2>&1; then
    echo "Missing prebuilds for local addon. Run 'npm run build' or pass --addon @qvac/llm-llamacpp@<version>."
    exit 1
  fi
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
if [[ -n "${ADDON}" ]]; then
  qvac_args=(--config "${CONFIG}" --params "${PARAMS}" --reps "${REPS}" --addon "${ADDON_MODULE}")
else
  qvac_args=(--config "${CONFIG}" --params "${PARAMS}" --reps "${REPS}")
fi
if [[ "${QUICK}" == "true" ]]; then
  qvac_args+=(--quick)
fi
set +e
bare "${PERF_DIR}/qvac-perf.js" "${qvac_args[@]}"
qvac_status=$?
set -e
if [[ $qvac_status -ne 0 ]]; then
  echo "⚠️  QVAC perf failed with exit code ${qvac_status}, continuing."
  FAILURES=1
fi

echo "==> Running PyTorch perf"
torch_args=(--config "${CONFIG}" --params "${PARAMS}" --reps "${REPS}")
if [[ -n "${HF_TOKEN}" ]]; then
  torch_args+=(--hf-token "${HF_TOKEN}")
fi
if [[ "${QUICK}" == "true" ]]; then
  torch_args+=(--quick)
fi
set +e
"${VENV_PY}" "${PERF_DIR}/pytorch-perf.py" "${torch_args[@]}"
torch_status=$?
set -e
if [[ $torch_status -ne 0 ]]; then
  echo "⚠️  PyTorch perf failed with exit code ${torch_status}, continuing."
  FAILURES=1
fi

if [[ "${RUN_JUDGE}" == "true" ]]; then
  echo "==> Running judge"
  for file in "${PERF_DIR}"/results/qvac_*.jsonl; do
    [[ -e "$file" ]] || continue
    set +e
    bare "${PERF_DIR}/judge.js" --config "${CONFIG}" --input "$file"
    judge_status=$?
    set -e
    if [[ $judge_status -ne 0 ]]; then
      echo "⚠️  Judge failed for ${file} with exit code ${judge_status}, continuing."
      FAILURES=1
    fi
  done
fi

if [[ "${RUN_ANALYSIS}" == "true" ]]; then
  echo "==> Running analysis"
  set +e
  "${VENV_PY}" "${PERF_DIR}/analysis/analyze.py" --input "${PERF_DIR}/results" --output "${PERF_DIR}/analysis/plots"
  analyze_status=$?
  set -e
  if [[ $analyze_status -ne 0 ]]; then
    echo "⚠️  Analysis failed with exit code ${analyze_status}."
    FAILURES=1
  fi
fi

if [[ $FAILURES -ne 0 ]]; then
  echo "❌ One or more benchmark stages failed."
  exit 1
fi
