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
release_require_root || exit 2

if [[ ${production_mode} == 1 ]]; then
  releases_root=/opt/fireside/releases
  current_link=/opt/fireside/current
  state_root=/var/lib/fireside-release
  runtime_root=/run/fireside-runtime
  lock_file=/run/fireside-release.lock
  database_path=/var/lib/fireside/fireside.db
  backup_directory=/var/backups/fireside
elif [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} == 1 ]]; then
  releases_root=${FIRESIDE_RELEASES_ROOT:?test releases root is required}
  current_link=${FIRESIDE_CURRENT_LINK:?test current link is required}
  state_root=${FIRESIDE_RELEASE_STATE_ROOT:?test state root is required}
  runtime_root=${FIRESIDE_RUNTIME_ROOT:?test runtime root is required}
  lock_file=${FIRESIDE_RELEASE_LOCK_FILE:?test lock path is required}
  database_path=${FIRESIDE_DATABASE_PATH:?test database path is required}
  backup_directory=${FIRESIDE_BACKUP_DIRECTORY:?test backup directory is required}
else
  release_die 'production backups must use the installed root-owned controller'
  exit 2
fi

release_validate_lock_file "${lock_file}" "${EUID}" "$(id -g)" || exit 2
exec 9<"${lock_file}"
flock -s -w 120 9 || { release_die 'backup timed out waiting for the release lock' || true; exit 75; }

[[ ! -e ${state_root}/transaction && ! -L ${state_root}/transaction ]] \
  || { release_die 'backup refuses an active release transaction' || true; exit 4; }
[[ ! -e ${runtime_root}/release-active && ! -L ${runtime_root}/release-active ]] \
  || { release_die 'backup refuses an active release marker' || true; exit 4; }

selected=$(release_resolve_link "${runtime_root}/current" "${releases_root}") || exit 4
current=$(release_resolve_link "${current_link}" "${releases_root}") || exit 4
[[ ${selected} == "${current}" ]] || { release_die 'backup runtime selector does not match current' || true; exit 4; }
commit=${selected##*/}
release_require_healthy_marker "${state_root}" "${selected}" || exit 4

permit=${runtime_root}/writes-enabled
release_require_regular_file "${permit}" || exit 4
if [[ ${production_mode} == 1 ]]; then
  [[ $(stat -c '%U:%G:%a:%h' -- "${permit}") == root:root:444:1 ]] \
    || { release_die 'backup write permit metadata is invalid' || true; exit 4; }
else
  [[ $(stat -c '%a:%h' -- "${permit}") == 444:1 ]] || exit 4
fi
[[ $(<"${permit}") == "${commit}" ]] \
  || { release_die 'backup write permit does not match current' || true; exit 4; }

exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production \
  DATABASE_PATH="${database_path}" BACKUP_DIRECTORY="${backup_directory}" BACKUP_RETENTION=14 \
  /usr/bin/node "${selected}/server-build/server/backup-cli.js"
