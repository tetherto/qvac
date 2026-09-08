#!/usr/bin/env bash
# Idempotency guard for loops that publish several packages at one version.
#
# `npm view <name>@<version> version` fails for two very different reasons, and
# collapsing them is what breaks a re-run after a partial publish: a transient
# registry error would look like "not published", the loop would publish into an
# immutable version, npm would answer 403, and `set -e` would abort the release
# before the meta package ships.
#
# Returns 0 only on a confirmed hit, 1 only on a confirmed miss (E404, or the
# rc-0-with-empty-output form npm uses for a missing version of a package that
# does exist), and exits the shell on anything else so the failure is loud.
#
# Usage:
#   source .github/scripts/npm-version-state.sh
#   if npm_version_published "$NAME" "$VERSION"; then ...; fi

npm_version_published() {
  local name="$1"
  local version="$2"
  local out rc

  set +e
  out=$(npm view "${name}@${version}" version 2>&1)
  rc=$?
  set -e

  if [ "$rc" -eq 0 ]; then
    if [ -n "$out" ]; then
      return 0
    fi
    return 1
  fi

  case "$out" in
    *E404*) return 1 ;;
  esac

  echo "::error title=npm view failed::Could not determine whether ${name}@${version} is published (exit ${rc}). Refusing to publish blind into a possibly immutable version. Re-run after the registry recovers." >&2
  echo "$out" >&2
  exit 1
}
