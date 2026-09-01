#!/bin/bash -p
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset CDPATH ENV BASH_ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
script_path=$(readlink -f -- "${BASH_SOURCE[0]}")
script_dir=$(cd -- "$(dirname -- "${script_path}")" && pwd)
# shellcheck source=ops/release-lib.sh
source "${script_dir}/release-lib.sh"
production_mode=0
if release_is_production_controller "${script_dir}"; then
  production_mode=1
  release_reject_production_overrides "${script_dir}" || exit 2
fi
release_sanitize_environment
release_require_root
commit=${1:-}
if [[ -z ${commit} ]]; then
  commit=--previous
elif [[ $# -ne 1 ]]; then
  echo 'usage: fireside-release rollback [--previous|<40-character-commit>]' >&2
  exit 2
fi
exec "${script_dir}/promote-release.sh" --rollback "${commit}"
