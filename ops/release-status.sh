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
if [[ ${production_mode} == 1 ]]; then
  releases_root=/opt/fireside/releases
  current_link=/opt/fireside/current
  previous_link=/opt/fireside/previous
  state_root=/var/lib/fireside-release
elif [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} == 1 ]]; then
  releases_root=${FIRESIDE_RELEASES_ROOT:?test releases root is required}
  current_link=${FIRESIDE_CURRENT_LINK:?test current link is required}
  previous_link=${FIRESIDE_PREVIOUS_LINK:?test previous link is required}
  state_root=${FIRESIDE_RELEASE_STATE_ROOT:?test state root is required}
else
  release_die 'use the installed root-owned controller'
fi
current=$(release_resolve_link "${current_link}" "${releases_root}")
previous=none
if [[ -L ${previous_link} ]]; then previous=$(release_resolve_link "${previous_link}" "${releases_root}"); fi
journal=clean
if [[ -e ${state_root}/transaction || -L ${state_root}/transaction ]]; then journal=recovery-required; fi
printf 'current=%s\nprevious=%s\njournal=%s\n' "${current##*/}" "${previous##*/}" "${journal}"
