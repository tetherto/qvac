#!/usr/bin/env bash
# QVAC-26667 prototype: checks that the decision stack resolves to this
# checkout's workspace packages, not to published copies (which pnpm also
# installs inside the checkout, under node_modules/.pnpm). Run from anywhere
# in the repo after `pnpm install` and the builds; exits non-zero on any
# mismatch, and the prototype must not run then.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

check() { # <from-package-dir> <dependency> <expected-dir>
  local want got
  want=$(cd "$3" 2>/dev/null && pwd -P) || { err "no directory $3"; return; }
  got=$(cd "$1" && node -p "require('path').dirname(require('fs').realpathSync(require.resolve('$2/package')))" 2>/dev/null) \
    || { err "$2 does not resolve from $1"; return; }
  [ "$got" = "$want" ] || { err "$2 from $1 -> $got (expected $want)"; return; }
  echo "ok   $2 from $1"
}
check packages/sdk            @qvac/inference      packages/inference
check packages/sdk            @qvac/embed-llamacpp packages/embed-llamacpp
check packages/inference      @qvac/embed-llamacpp packages/embed-llamacpp
check packages/embed-llamacpp @qvac/fabric         packages/fabric
check packages/cli            @qvac/sdk            packages/sdk

host=$(node -p "process.platform + '-' + process.arch") || err "cannot read host"
pkg="packages/fabric/node_modules/@qvac/fabric-$host"
link="$pkg/prebuilds/$host"
[ -f "$pkg/package.json" ] || err "platform package $pkg missing (run link:platform)"
if [ -L "$link" ]; then
  got=$(cd "$link" 2>/dev/null && pwd -P) || err "$link is a dangling symlink"
  want=$(cd "packages/fabric/prebuilds/$host" 2>/dev/null && pwd -P) || err "no packages/fabric/prebuilds/$host"
  [ "${got:-}" = "${want:-}" ] || err "$link -> ${got:-?} (expected ${want:-?})"
else
  err "$link is not a symlink"
fi

[ "$fail" -eq 0 ] || { echo "resolution check failed; not running the prototype" >&2; exit 1; }
echo "resolution check passed"
