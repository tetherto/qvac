#!/usr/bin/env bash
set -euo pipefail

if [[ "${BUILD_PLATFORM:-}" != "linux" || "${BUILD_ARCH:-}" != "arm64" ]]; then
  exit 0
fi

case "$(basename "$PWD")" in
  ggml-rpc-server|llm-llamacpp) ;;
  *)
    echo "RPC RDMA validation must run from an RPC package directory" >&2
    exit 1
    ;;
esac

rm -rf build prebuilds
bare-make generate \
  --platform "$BUILD_PLATFORM" \
  --arch "$BUILD_ARCH" \
  -D BUILD_TESTING=OFF \
  -D RPC_RDMA=ON
bare-make build
bare-make install

ABI_INFO=$(find build/_vcpkg -path '*/share/qvac-fabric/vcpkg_abi_info.txt' -print -quit || true)
if [[ -z "$ABI_INFO" ]] || ! grep -Eq '^features .*rpc-rdma' "$ABI_INFO"; then
  echo "qvac-fabric was not built with the rpc-rdma feature" >&2
  exit 1
fi

if [[ "$(basename "$PWD")" == "ggml-rpc-server" ]]; then
  RPC_SERVER=$(find prebuilds -type f -name ggml-rpc-server -print -quit)
  if [[ -z "$RPC_SERVER" ]] || ! grep -aFq 'RDMA auto-negotiate enabled' "$RPC_SERVER"; then
    echo "ggml-rpc-server does not contain the RDMA capability marker" >&2
    exit 1
  fi
fi

echo "Validated rpc-rdma build for $(basename "$PWD") on ${BUILD_PLATFORM}-${BUILD_ARCH}"
