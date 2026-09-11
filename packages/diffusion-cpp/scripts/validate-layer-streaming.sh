#!/usr/bin/env bash
set -euo pipefail

# Linux GPU validation runner. The assertions depend on stable-diffusion.cpp's
# DEBUG diagnostics and Linux GPU-memory interfaces.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="${H3_MODELS_DIR:-/home/shared/models/minimax-h3-q2}"
MACHINE_LABEL="${MACHINE_LABEL:-$(hostname -s)}"
RUN_ID="${RUN_ID:-$(date +%Y%m%dT%H%M%S)}"
RESULTS_DIR="${RESULTS_DIR:-$PACKAGE_DIR/validation-results/$MACHINE_LABEL-$RUN_ID}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-1}"
BACKEND="${BACKEND:-vulkan0}"

DIFFUSION_FILE="${H3_MODEL:-minimax_h3_fl2va_pruned-Q2_K.gguf}"
LLM_FILE="${H3_LLM:-qwen3vl_32b_minimax_h3-Q2_K_M.gguf}"

required_files=(
  "$MODELS_DIR/$DIFFUSION_FILE"
  "$MODELS_DIR/$LLM_FILE"
  "$MODELS_DIR/vae/minimax_h3_video_vae_fp16.safetensors"
  "$MODELS_DIR/vae/minimax_h3_audio_vae_fp32.safetensors"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing model file: $file" >&2
    exit 2
  fi
done

if ! command -v bare >/dev/null 2>&1; then
  echo "bare is not available in PATH" >&2
  exit 2
fi

mkdir -p "$RESULTS_DIR/logs" "$RESULTS_DIR/metrics" "$RESULTS_DIR/output"

SYSTEM_INFO="$RESULTS_DIR/system-info.txt"
{
  echo "machine=$MACHINE_LABEL"
  echo "host=$(hostname)"
  echo "commit=$(git -C "$PACKAGE_DIR" rev-parse HEAD)"
  echo "date=$(date --iso-8601=seconds)"
  uname -a
  if [[ -r /etc/os-release ]]; then
    cat /etc/os-release
  fi
  if command -v lspci >/dev/null 2>&1; then
    lspci | grep -Ei 'vga|3d|display' || true
  fi
  if command -v vulkaninfo >/dev/null 2>&1; then
    vulkaninfo --summary || true
  fi
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi || true
  fi
} >"$SYSTEM_INFO" 2>&1

SUMMARY="$RESULTS_DIR/summary.tsv"
printf 'case\texit_code\tlog\tmetrics\toutput\n' >"$SUMMARY"
failure_count=0
time_command=()
if [[ -x /usr/bin/time ]]; then
  time_command=(/usr/bin/time -v)
fi

sample_gpu_memory() {
  local output_file="$1"
  local process_id="$2"

  printf 'timestamp\tgpu_memory_mib\n' >"$output_file"
  while kill -0 "$process_id" 2>/dev/null; do
    local used=""
    if command -v nvidia-smi >/dev/null 2>&1; then
      used="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | paste -sd, - || true)"
    else
      local total_bytes=0
      local memory_file
      for memory_file in /sys/class/drm/card*/device/mem_info_vram_used; do
        if [[ -r "$memory_file" ]]; then
          local value
          read -r value <"$memory_file"
          if [[ "$value" =~ ^[0-9]+$ ]]; then
            total_bytes=$((total_bytes + 10#$value))
          fi
        fi
      done
      if (( total_bytes > 0 )); then
        used="$((total_bytes / 1024 / 1024))"
      fi
    fi
    printf '%s\t%s\n' "$(date +%s)" "${used:-unavailable}" >>"$output_file"
    sleep "$SAMPLE_INTERVAL"
  done
}

run_case() {
  local name="$1"
  local backend="$2"
  local params_backend="$3"
  local max_vram="$4"
  local stream_layers="$5"
  local expected_log="${6:-}"
  local expected_log_2="${7:-}"
  local expected_log_3="${8:-}"
  local forbidden_log="${9:-}"
  local offload_to_cpu="${10:-0}"
  local log_file="$RESULTS_DIR/logs/$name.log"
  local metrics_file="$RESULTS_DIR/metrics/$name.tsv"
  local output_file="$RESULTS_DIR/output/$name.avi"
  local -a case_env=(
    "H3_MODELS_DIR=$MODELS_DIR"
    "H3_MODEL=$DIFFUSION_FILE"
    "H3_LLM=$LLM_FILE"
    "H3_OUTPUT_DIR=$RESULTS_DIR/output"
    "H3_DEVICE=gpu"
    "H3_OFFLOAD_TO_CPU=$offload_to_cpu"
    "H3_VERBOSITY=3"
    "H3_STREAM_LAYERS=$stream_layers"
    "H3_BACKEND=$backend"
    "WIDTH=${WIDTH:-320}"
    "HEIGHT=${HEIGHT:-192}"
    "FRAMES=${FRAMES:-22}"
    "STEPS=${STEPS:-1}"
    "SEED=${SEED:-11}"
    "OUTPUT=$name.avi"
  )

  if [[ -n "$params_backend" ]]; then
    case_env+=("H3_PARAMS_BACKEND=$params_backend")
  fi
  if [[ -n "$max_vram" ]]; then
    case_env+=("H3_MAX_VRAM=$max_vram")
  fi

  echo "Running $name"
  printf 'case=%s\nbackend=%s\nparams_backend=%s\nmax_vram=%s\nstream_layers=%s\noffload_to_cpu=%s\n\n' \
    "$name" "$backend" "${params_backend:-unset}" "${max_vram:-unset}" \
    "$stream_layers" "$offload_to_cpu" >"$log_file"
  set +e
  (
    cd "$PACKAGE_DIR"
    "${time_command[@]}" env -u H3_PARAMS_BACKEND -u H3_MAX_VRAM \
      "${case_env[@]}" bare examples/generate-video-minimax-h3.js
  ) >>"$log_file" 2>&1 &
  local run_pid=$!
  sample_gpu_memory "$metrics_file" "$run_pid" &
  local sampler_pid=$!
  wait "$run_pid"
  local status=$?
  wait "$sampler_pid" 2>/dev/null
  set -e

  if ((status == 0)) && [[ ! -s "$output_file" ]]; then
    echo "Validation failed: $name did not produce a non-empty AVI" >>"$log_file"
    status=1
  fi
  if ((status == 0)) && [[ -n "$expected_log" ]] &&
    ! grep -Fq -- "$expected_log" "$log_file"; then
    echo "Validation failed: missing log evidence: $expected_log" >>"$log_file"
    status=1
  fi
  if ((status == 0)) && [[ -n "$expected_log_2" ]] &&
    ! grep -Fq -- "$expected_log_2" "$log_file"; then
    echo "Validation failed: missing log evidence: $expected_log_2" >>"$log_file"
    status=1
  fi
  if ((status == 0)) && [[ -n "$expected_log_3" ]] &&
    ! grep -Fq -- "$expected_log_3" "$log_file"; then
    echo "Validation failed: missing log evidence: $expected_log_3" >>"$log_file"
    status=1
  fi
  if ((status == 0)) && [[ -n "$forbidden_log" ]] &&
    grep -Fq -- "$forbidden_log" "$log_file"; then
    echo "Validation failed: unexpected log evidence: $forbidden_log" >>"$log_file"
    status=1
  fi

  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$status" "$log_file" "$metrics_file" "$output_file" >>"$SUMMARY"
  if ((status != 0)); then
    failure_count=$((failure_count + 1))
  fi
}

graph_cut_log="graph cut max_vram budget merge took"
stream_ignored_log="--stream-layers has no effect unless diffusion params backend is cpu; ignoring"
# Addon logs confirm the effective C API assignments. Engine logs confirm that
# graph cutting and streaming used those assignments.
max_vram_log="Effective stable-diffusion max_vram"
params_backend_log="Effective stable-diffusion params backend"
backend_log="Explicit stable-diffusion backend assignment"

run_case baseline "$BACKEND" "" "" 0 "" "" "" "$graph_cut_log"
run_case disabled "$BACKEND" "" 0 0 "$max_vram_log '0'" "" "" "$graph_cut_log"
run_case fixed-low "$BACKEND" "" 2 0 "$graph_cut_log" "$max_vram_log '2'"
run_case fixed-medium "$BACKEND" "" 6 0 "$graph_cut_log" "$max_vram_log '6'"
run_case auto "$BACKEND" "" -1 0 "$graph_cut_log" "$max_vram_log '-1'"
run_case assigned "$BACKEND" "" "$BACKEND=6" 0 "$graph_cut_log" \
  "$max_vram_log '$BACKEND=6'"
run_case stream-without-max-vram "$BACKEND" diffusion=cpu "" 1 \
  "stream_layers has no effect without max_vram; ignoring" "" "" \
  "$graph_cut_log"
run_case stream-without-cpu "$BACKEND" "" 6 1 "$graph_cut_log" \
  "$max_vram_log '6'" "$stream_ignored_log"
run_case cpu-staged "$BACKEND" diffusion=cpu 6 0 "$graph_cut_log" \
  "$max_vram_log '6'" "$params_backend_log 'diffusion=cpu'"
run_case cpu-streamed "$BACKEND" diffusion=cpu 6 1 "$graph_cut_log" \
  "streaming budget =" "residency=STREAMED"
run_case disk "$BACKEND" diffusion=disk 6 0 "$graph_cut_log" \
  "$max_vram_log '6'" "$params_backend_log 'diffusion=disk'"
run_case disk-with-stream "$BACKEND" diffusion=disk 6 1 "$stream_ignored_log" \
  "$max_vram_log '6'" "$params_backend_log 'diffusion=disk'"
run_case runtime-mix "diffusion=$BACKEND,te=cpu,vae=cpu" "" 6 0 "$graph_cut_log" \
  "$max_vram_log '6'" "$backend_log 'diffusion=$BACKEND,te=cpu,vae=cpu'"
run_case params-mix "$BACKEND" diffusion=cpu,te=cpu,vae=cpu 6 0 "$graph_cut_log" \
  "$max_vram_log '6'" "$params_backend_log 'diffusion=cpu,te=cpu,vae=cpu'"
run_case offload-only "$BACKEND" "" 6 0 "$graph_cut_log" "$max_vram_log '6'" \
  "$params_backend_log '*=cpu'" "" 1
run_case offload-with-params "$BACKEND" diffusion=disk 6 0 "$graph_cut_log" \
  "$max_vram_log '6'" "$params_backend_log '*=cpu,diffusion=disk'" "" 1

echo "Validation complete: $RESULTS_DIR"
column -t -s $'\t' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
if ((failure_count != 0)); then
  echo "$failure_count validation case(s) failed" >&2
  exit 1
fi
