#!/usr/bin/env bash
# The VLM matrix's desktop legs for this host: each backend in
# VLM_BACKENDS over the addon sources (published, this run's candidate, a baseline release), plus the fabric and
# upstream CLIs in several-sources mode. Logs and provenance land in benchmarks/results/vlm for the report.
set -euo pipefail
cd "$(dirname "$0")/.."

host=$VLM_HOST
out=benchmarks/results/vlm
mkdir -p "$out" builds
head_sha=$(git rev-parse HEAD)
node benchmarks/vlm-benchmark/run-desktop.cjs --selfcheck

baseline=$BM_BASELINE_NPM
[ -n "$baseline" ] || baseline=$(npm view @qvac/llm-llamacpp version 2>/dev/null || true)
[ -n "$baseline" ] || baseline=$(node -e "console.log(require('./benchmarks/vlm-benchmark/config.cjs').defaultBaseline.npm)")
fabric_ref=v8189.0.2 upstream_ref=b8189
if [ "$BM_MODE" = several-sources ]; then
  eval "$(node benchmarks/vlm-benchmark/resolve-versions.cjs "$BM_SOURCES" | grep -E '^(fabric_ref|upstream_ref)=[A-Za-z0-9._-]+$')"
fi

# This run's build is the candidate; the published release is the default source.
cp -r prebuilds builds/candidate-prebuilds
pack() { # <spec> <dest>
  local dir
  dir=$(mktemp -d)
  (cd "$dir" && npm pack "$1" >/dev/null && tar -xzf ./*.tgz)
  rm -rf "$2" && mv "$dir/package/prebuilds" "$2"
  node -e "console.log(require('$dir/package/package.json').version)"
}
addon_version=$(pack @qvac/llm-llamacpp@latest builds/published-prebuilds)
if [[ ",$BM_SOURCES," == *,addon@baseline,* ]]; then pack "@qvac/llm-llamacpp@$baseline" builds/baseline-prebuilds >/dev/null; fi

aws s3 sync s3://tether-ai-dev/vlm-benchmark/ benchmarks/vlm-benchmark/fixture/
npx brittle -r test/integration/all.js benchmarks/vlm-benchmark/vlm-matrix.test.js
link() { node -e "const fs=require('fs'),p=require('path');try{fs.rmSync('prebuilds',{recursive:true,force:true})}catch{};fs.symlinkSync(p.resolve(process.argv[1]),'prebuilds',process.platform==='win32'?'junction':'dir')" "$1"; }

rc=0
IFS=, read -ra backends <<<"$VLM_BACKENDS"
for backend in "${backends[@]}"; do
  log="$out/vlm-matrix-$host-$backend.log"
  : >"$log"
  if [ "$host" = linux ] && [ "$backend" = gpu ]; then export VULKAN_SDK=/opt/vulkansdk/x86_64 PATH="/opt/vulkansdk/x86_64/bin:$PATH"; fi
  srcs=addon
  if [ "$BM_MODE" = several-sources ]; then
    srcs=$(QVAC_VLM_SOURCES="$BM_SOURCES" node -e "const s=require('./benchmarks/vlm-benchmark/sources.cjs');const a=s.parseSources(process.env.QVAC_VLM_SOURCES||'addon').filter(x=>x.type==='addon').map(x=>x.id);process.stdout.write((a.length?a:['addon']).join(' '))")
  fi
  for src in $srcs; do
    case "$src" in
      addon@candidate) link builds/candidate-prebuilds; ref="git:$head_sha" ;;
      addon@baseline) link builds/baseline-prebuilds; ref="npm:$baseline" ;;
      *) link builds/published-prebuilds; ref="npm:$addon_version" ;;
    esac
    echo ">> VLM matrix $host/$backend source=$src ref=$ref"
    QVAC_VLM_MATRIX=1 QVAC_VLM_MODE=$BM_MODE QVAC_VLM_PRESET=$BM_PRESET QVAC_VLM_ENGINE=addon QVAC_VLM_SAMPLES=$BM_SAMPLES \
      QVAC_VLM_DEVICES=$backend QVAC_VLM_MODELS=$BM_MODELS QVAC_VLM_SOURCES=$BM_SOURCES \
      QVAC_VLM_SOURCE_ID=$src QVAC_VLM_SOURCE_REF=$ref NO_GPU=$([ "$backend" = cpu ] && echo true || echo false) \
      bare test/integration/all.js --exit 2>&1 | tee -a "$log" || rc=$?
  done
  # The native CLIs run from the benchmark folder over the same fixture.
  cli=""
  case ",$BM_SOURCES," in *,fabric,* | *,fabric@*) cli=fabric ;; esac
  case ",$BM_SOURCES," in *,upstream,* | *,upstream@*) cli="${cli:+$cli,}upstream" ;; esac
  if [ "$BM_MODE" = several-sources ] && [ -n "$cli" ]; then
    (
      cd benchmarks/vlm-benchmark
      preset() { node -e "const p=(require('./config.cjs').presets[process.argv[1]]||{});const v=p[process.argv[2]];console.log(Array.isArray(v)?v.join(','):typeof v==='object'?JSON.stringify(v):(v??process.argv[3]))" "$BM_PRESET" "$1" "$2"; }
      samples=${BM_SAMPLES:-$(preset samplesPerTask 3)}
      node build-cli-sources.js --sources="$cli" --fabric-ref="$fabric_ref" --upstream-ref="$upstream_ref" --backend="$backend"
      model=../../test/model
      for s in ${cli//,/ }; do
        node cli-fixture-runner.cjs --binary "$(node -e "console.log(require('./cli-sources-resolved.json')['$s'].binaryPath)")" \
          --source "$s-cli" --llm "$model/reg-qwen-unsloth-Q8_0.gguf" --mmproj "$model/reg-qwen-mradermacher-mmproj-Q8_0.gguf" \
          --backend "$backend" --samples "$samples" --repeats "$(preset repeats 1)" \
          --tasks "$(preset tasks textvqa,vizwiz,gqa,docvqa,ai2d,ocr-small,ocr-page)" --ids "$(preset ids '')" \
          --task-samples "$(preset taskSamples '{}')" --max-tasks "$(preset maxTasks 0)" \
          --main-origin "Qwen3.5-0.8B-Q8_0 (Registry)" --mmproj-origin "Qwen3.5-0.8B mmproj-Q8_0 (Registry)" \
          >>"../../$log" 2>&1 || echo "::warning::$s CLI run had errors"
      done
    )
  fi
  {
    echo "**$host · $backend**"
    echo "- addon: \`@qvac/llm-llamacpp@$addon_version\` (published prebuild)"
    echo "- benchmark code: \`$head_sha\`"
    echo "- node: $(node -v) · os: $(uname -srm)"
  } >"$out/prov-$host-$backend.md"
done
link builds/candidate-prebuilds
exit "$rc"
