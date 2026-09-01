#!/bin/bash -p
set -uo pipefail

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
test_mode=${FIRESIDE_RELEASE_TEST_MODE:-0}
if [[ ${production_mode} == 1 ]]; then
  test_mode=0
  releases_root=/opt/fireside/releases
  current_link=/opt/fireside/current
  previous_link=/opt/fireside/previous
  state_root=/var/lib/fireside-release
  backup_directory=/var/backups/fireside
  database_path=/var/lib/fireside/fireside.db
  lock_file=/run/fireside-release.lock
  gate_lock_file=/run/fireside-release-gate.lock
  preflight_root=/run
  sensitive_preflight_root=/var/lib/fireside-release/preflight
  runtime_root=/run/fireside-runtime
  build_user=fireside-build
elif [[ ${test_mode} == 1 ]]; then
  releases_root=${FIRESIDE_RELEASES_ROOT:?test releases root is required}
  current_link=${FIRESIDE_CURRENT_LINK:?test current link is required}
  previous_link=${FIRESIDE_PREVIOUS_LINK:?test previous link is required}
  state_root=${FIRESIDE_RELEASE_STATE_ROOT:?test state root is required}
  backup_directory=${FIRESIDE_BACKUP_DIRECTORY:?test backup directory is required}
  database_path=${FIRESIDE_DATABASE_PATH:?test database path is required}
  lock_file=${FIRESIDE_RELEASE_LOCK_FILE:?test lock path is required}
  gate_lock_file=${FIRESIDE_RELEASE_GATE_LOCK_FILE:-${lock_file}.gate}
  preflight_root=${FIRESIDE_PREFLIGHT_ROOT:?test preflight root is required}
  sensitive_preflight_root=${FIRESIDE_SENSITIVE_PREFLIGHT_ROOT:-${preflight_root%/}/sensitive-preflight}
  runtime_root=${FIRESIDE_RUNTIME_ROOT:?test runtime root is required}
  build_user=${FIRESIDE_BUILD_USER:-fireside-build}
else
  release_die 'production releases must use the installed root-owned controller'
  exit 2
fi
journal_file="${state_root}/transaction"
transaction_id=legacy
transaction_owner_pid=none
transaction_owner_starttime=none
transaction_owner_boot_id=none
transaction_lock_identity=none
transaction_permit_commit=none
transaction_permit_purpose=none
transaction_permit_generation=0
transaction_permit_state=none
transaction_database_backup_size=none
transaction_database_backup_sha256=none
gate_mutex_held=0

sync_path() {
  if [[ ${test_mode} == 1 ]]; then
    if [[ -n ${FIRESIDE_RELEASE_SYNC_HOOK:-} ]]; then
      "${FIRESIDE_RELEASE_SYNC_HOOK}" "$1" 8>&- 9>&-
      return
    fi
    return 0
  else
    /bin/sync -f "$1" 8>&- 9>&-
  fi
}

write_transaction() {
  local from_commit=$1 to_commit=$2 original_previous=$3 mode=$4 phase=$5 database_backup=${6:-none}
  install -d -o root -g root -m 0700 "${state_root}" 8>&- 9>&- || return 1
  if [[ -e ${journal_file} || -L ${journal_file} ]]; then
    release_require_regular_file "${journal_file}" || return 1
    if [[ ${test_mode} != 1 ]]; then
      [[ $(stat -c '%U:%G:%a:%h' -- "${journal_file}" 8>&- 9>&-) == root:root:600:1 ]] || return 1
    fi
  fi
  local temporary="${state_root}/.transaction.$$"
  umask 077
  {
    if [[ ${transaction_id} == legacy ]]; then printf 'version=1\n'; else printf 'version=2\n'; fi
    printf 'from=%s\n' "${from_commit}"
    printf 'to=%s\n' "${to_commit}"
    printf 'original_previous=%s\n' "${original_previous}"
    printf 'mode=%s\n' "${mode}"
    printf 'phase=%s\n' "${phase}"
    printf 'database_backup=%s\n' "${database_backup}"
    if [[ ${transaction_id} != legacy ]]; then
      printf 'transaction_id=%s\n' "${transaction_id}"
      printf 'owner_pid=%s\n' "${transaction_owner_pid}"
      printf 'owner_starttime=%s\n' "${transaction_owner_starttime}"
      printf 'owner_boot_id=%s\n' "${transaction_owner_boot_id}"
      printf 'lock_identity=%s\n' "${transaction_lock_identity}"
      printf 'permit_commit=%s\n' "${transaction_permit_commit}"
      printf 'permit_purpose=%s\n' "${transaction_permit_purpose}"
      printf 'permit_generation=%s\n' "${transaction_permit_generation}"
      printf 'permit_state=%s\n' "${transaction_permit_state}"
      printf 'database_backup_size=%s\n' "${transaction_database_backup_size}"
      printf 'database_backup_sha256=%s\n' "${transaction_database_backup_sha256}"
    fi
  } > "${temporary}" || return 1
  if [[ ${test_mode} != 1 ]] && ! chown root:root "${temporary}" 8>&- 9>&-; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
  if ! chmod 0600 "${temporary}" 8>&- 9>&- \
    || ! sync_path "${temporary}" \
    || ! mv -Tf -- "${temporary}" "${journal_file}" 8>&- 9>&- \
    || ! sync_path "${state_root}"; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
}

read_transaction() {
  tx_version= tx_from= tx_to= tx_previous= tx_mode= tx_phase= tx_database_backup=none
  tx_transaction_id=legacy tx_owner_pid=none tx_owner_starttime=none tx_owner_boot_id=none
  tx_lock_identity=none tx_permit_commit=none tx_permit_purpose=none tx_permit_generation=0 tx_permit_state=none
  tx_database_backup_size=none tx_database_backup_sha256=none
  release_require_regular_file "${journal_file}" || return 1
  if [[ ${test_mode} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a:%h' -- "${journal_file}") == root:root:600:1 ]] || return 1
  fi
  local key value
  while IFS='=' read -r key value; do
    case "${key}" in
      version) tx_version=${value} ;;
      from) tx_from=${value} ;;
      to) tx_to=${value} ;;
      original_previous) tx_previous=${value} ;;
      mode) tx_mode=${value} ;;
      phase) tx_phase=${value} ;;
      database_backup) tx_database_backup=${value} ;;
      transaction_id) tx_transaction_id=${value} ;;
      owner_pid) tx_owner_pid=${value} ;;
      owner_starttime) tx_owner_starttime=${value} ;;
      owner_boot_id) tx_owner_boot_id=${value} ;;
      lock_identity) tx_lock_identity=${value} ;;
      permit_commit) tx_permit_commit=${value} ;;
      permit_purpose) tx_permit_purpose=${value} ;;
      permit_generation) tx_permit_generation=${value} ;;
      permit_state) tx_permit_state=${value} ;;
      database_backup_size) tx_database_backup_size=${value} ;;
      database_backup_sha256) tx_database_backup_sha256=${value} ;;
      *) return 1 ;;
    esac
  done < "${journal_file}"
  [[ ${tx_version} == 1 || ${tx_version} == 2 ]] || return 1
  release_require_full_commit "${tx_to}" || return 1
  [[ ${tx_previous} == none || ${tx_previous} =~ ^[0-9a-f]{40}$ ]] || return 1
  if [[ ${tx_mode} == bootstrap ]]; then
    [[ ${tx_from} == none && ${tx_previous} == none ]] || return 1
    [[ ${tx_database_backup} == none || ${tx_database_backup} =~ ^fireside-backup-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{16}\.sqlite3$ ]] || return 1
  else
    release_require_full_commit "${tx_from}" || return 1
    [[ ${tx_mode} == promote || ${tx_mode} == rollback ]] || return 1
    [[ ${tx_database_backup} == none ]] || return 1
  fi
  [[ ${tx_phase} == prepared || ${tx_phase} == switched || ${tx_phase} == healthy \
    || ${tx_phase} == previous || ${tx_phase} == reverting || ${tx_phase} == committed ]] || return 1
  if [[ ${tx_version} == 2 ]]; then
    [[ ${tx_transaction_id} =~ ^[0-9a-f]{32}$ ]] || return 1
    [[ ${tx_owner_pid} =~ ^[1-9][0-9]*$ && ${tx_owner_starttime} =~ ^[1-9][0-9]*$ ]] || return 1
    [[ ${tx_owner_boot_id} =~ ^[0-9a-f-]{36}$ && ${tx_lock_identity} =~ ^[0-9]+:[0-9]+$ ]] || return 1
    [[ ${tx_permit_commit} == none || ${tx_permit_commit} =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ ${tx_permit_purpose} == none || ${tx_permit_purpose} == target || ${tx_permit_purpose} == recovery ]] || return 1
    [[ ${tx_permit_generation} =~ ^[0-9]+$ ]] || return 1
    [[ ${tx_permit_state} == none || ${tx_permit_state} == pending || ${tx_permit_state} == consumed ]] || return 1
    if [[ ${tx_permit_state} == none ]]; then
      [[ ${tx_permit_commit} == none && ${tx_permit_purpose} == none ]] || return 1
    else
      [[ ${tx_permit_commit} != none && ${tx_permit_purpose} != none ]] || return 1
    fi
    if [[ ${tx_mode} == bootstrap && ${tx_database_backup} != none ]]; then
      [[ ${tx_database_backup_size} =~ ^[1-9][0-9]*$ \
        && ${tx_database_backup_sha256} =~ ^[0-9a-f]{64}$ ]] || return 1
    else
      [[ ${tx_database_backup_size} == none && ${tx_database_backup_sha256} == none ]] || return 1
    fi
  else
    [[ ${tx_transaction_id} == legacy && ${tx_permit_state} == none \
      && ${tx_database_backup} == none ]] || return 1
  fi
}

adopt_transaction_identity() {
  transaction_id=${tx_transaction_id}
  transaction_owner_pid=${tx_owner_pid}
  transaction_owner_starttime=${tx_owner_starttime}
  transaction_owner_boot_id=${tx_owner_boot_id}
  transaction_lock_identity=${tx_lock_identity}
  transaction_permit_commit=${tx_permit_commit}
  transaction_permit_purpose=${tx_permit_purpose}
  transaction_permit_generation=${tx_permit_generation}
  transaction_permit_state=${tx_permit_state}
  transaction_database_backup_size=${tx_database_backup_size}
  transaction_database_backup_sha256=${tx_database_backup_sha256}
}

begin_transaction_identity() {
  transaction_id=$(/usr/bin/od -An -N16 -tx1 /dev/urandom 8>&- 9>&- | /usr/bin/tr -d ' \n' 8>&- 9>&-) || return 1
  [[ ${transaction_id} =~ ^[0-9a-f]{32}$ ]] || return 1
  transaction_owner_pid=$$
  transaction_owner_starttime=$(awk '{print $22}' "/proc/$$/stat" 8>&- 9>&-) || return 1
  transaction_owner_boot_id=$(< /proc/sys/kernel/random/boot_id) || return 1
  transaction_lock_identity=$(stat -c '%d:%i' -- "${lock_file}" 8>&- 9>&-) || return 1
  transaction_permit_commit=none
  transaction_permit_purpose=none
  transaction_permit_generation=0
  transaction_permit_state=none
  transaction_database_backup_size=none
  transaction_database_backup_sha256=none
}

take_transaction_ownership() {
  transaction_owner_pid=$$
  transaction_owner_starttime=$(awk '{print $22}' "/proc/$$/stat" 8>&- 9>&-) || return 1
  transaction_owner_boot_id=$(< /proc/sys/kernel/random/boot_id) || return 1
  transaction_lock_identity=$(stat -c '%d:%i' -- "${lock_file}" 8>&- 9>&-) || return 1
}

start_transaction_watchdog() {
  local txid=$1
  if [[ ${test_mode} == 1 ]]; then
    "${FIRESIDE_RELEASE_WATCHDOG_HOOK:?test watchdog hook is required}" "${txid}" 8>&- 9>&-
    return
  fi
  release_systemd_run --quiet --collect --service-type=notify \
    --unit="fireside-release-watchdog-${txid}" \
    -p User=root -p Group=root -p NotifyAccess=main -p Restart=on-failure -p RestartSec=200ms \
    -p NoNewPrivileges=yes \
    -p 'CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER' \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes \
    -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p RestrictNamespaces=yes \
    -p ReadWritePaths='/opt/fireside /var/lib/fireside-release /var/lib/fireside /run' \
    -p ReadOnlyPaths=/var/backups/fireside -p InaccessiblePaths=/etc/fireside.env \
    -p TimeoutStartSec=15min -- \
    /usr/local/sbin/fireside-release watchdog "${txid}" 8>&- 9>&-
  release_systemctl is-active --quiet "fireside-release-watchdog-${txid}.service" 8>&- 9>&-
}

acquire_gate_mutex() {
  release_prepare_lock_file "${gate_lock_file}" "${EUID}" "$(id -g)" || return 1
  exec 8>"${gate_lock_file}"
  flock -w 120 8 || return 1
  gate_mutex_held=1
}

release_gate_mutex() {
  flock -u 8 2>/dev/null || true
  exec 8>&-
  gate_mutex_held=0
}

validate_release_active() {
  local expected_txid=${1:-any}
  local active_file="${runtime_root}/release-active" active_txid
  [[ -e ${active_file} || -L ${active_file} ]] || return 0
  release_require_regular_file "${active_file}" || return 1
  if [[ ${test_mode} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a:%h' -- "${active_file}" 8>&- 9>&-) == root:root:444:1 ]] || return 1
  else
    [[ $(stat -c '%h' -- "${active_file}" 8>&- 9>&-) == 1 ]] || return 1
  fi
  active_txid=$(<"${active_file}") || return 1
  [[ ${active_txid} =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ ${expected_txid} == any || ${active_txid} == "${expected_txid}" ]]
}

clear_transaction() {
  local expected_active=any journal_present=0
  if [[ -e ${journal_file} || -L ${journal_file} ]]; then
    journal_present=1
    read_transaction || return 1
    if [[ ${tx_version} == 2 ]]; then expected_active=${tx_transaction_id}; fi
  fi
  validate_release_active "${expected_active}" || return 1
  clear_release_active "${expected_active}" || return 1
  if [[ ${journal_present} == 1 ]]; then
    rm -f -- "${journal_file}" 8>&- 9>&- || return 1
    sync_path "${state_root}" || return 1
  fi
}

prepare_runtime_root() {
  install -d -o root -g root -m 0755 "${runtime_root}" 8>&- 9>&- || return 1
  if [[ ${test_mode} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a:%h' -- "${runtime_root}") == root:root:755:1 ]] || return 1
  fi
}

mark_release_active() {
  local txid=$1
  [[ ${txid} =~ ^[0-9a-f]{32}$ ]] || return 1
  prepare_runtime_root || return 1
  if [[ -e ${runtime_root}/release-active || -L ${runtime_root}/release-active ]]; then
    release_require_regular_file "${runtime_root}/release-active" || return 1
    if [[ ${test_mode} != 1 ]]; then
      [[ $(stat -c '%U:%G:%a:%h' -- "${runtime_root}/release-active" 8>&- 9>&-) == root:root:444:1 ]] || return 1
    fi
  fi
  local temporary="${runtime_root}/.release-active.$$"
  if ! printf '%s\n' "${txid}" > "${temporary}" \
    || ! chmod 0444 "${temporary}" 8>&- 9>&-; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
  if [[ ${test_mode} != 1 ]] && ! chown root:root "${temporary}" 8>&- 9>&-; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
  if ! sync_path "${temporary}" \
    || ! mv -Tf -- "${temporary}" "${runtime_root}/release-active" 8>&- 9>&- \
    || ! sync_path "${runtime_root}"; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
}

clear_release_active() {
  local expected_txid=${1:-any}
  if [[ -e ${runtime_root}/release-active || -L ${runtime_root}/release-active ]]; then
    validate_release_active "${expected_txid}" || return 1
    rm -f -- "${runtime_root}/release-active" 8>&- 9>&- || return 1
    sync_path "${runtime_root}" || return 1
  fi
}

set_runtime_selector() {
  local release_path=$1
  prepare_runtime_root || return 1
  release_validate_runtime_tree "${release_path}" || return 1
  release_atomic_link "${release_path}" "${runtime_root}/current" || return 1
  sync_path "${runtime_root}"
}

revoke_write_permit() {
  prepare_runtime_root || return 1
  if [[ -e ${runtime_root}/writes-enabled || -L ${runtime_root}/writes-enabled ]]; then
    rm -f -- "${runtime_root}/writes-enabled" 8>&- 9>&- || return 1
    sync_path "${runtime_root}" || return 1
  fi
}

publish_write_permit() {
  local commit=$1
  release_require_full_commit "${commit}" || return 1
  prepare_runtime_root || return 1
  if [[ -e ${runtime_root}/writes-enabled || -L ${runtime_root}/writes-enabled ]]; then
    release_require_regular_file "${runtime_root}/writes-enabled" || return 1
    if [[ ${test_mode} != 1 ]]; then
      [[ $(stat -c '%U:%G:%a:%h' -- "${runtime_root}/writes-enabled" 8>&- 9>&-) == root:root:444:1 ]] || return 1
    fi
  fi
  local temporary="${runtime_root}/.writes-enabled.$$"
  umask 077
  if ! printf '%s\n' "${commit}" > "${temporary}" \
    || ! chmod 0444 "${temporary}" 8>&- 9>&-; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
  if [[ ${test_mode} != 1 ]] && ! chown root:root "${temporary}" 8>&- 9>&-; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
  if ! sync_path "${temporary}" \
    || ! mv -Tf -- "${temporary}" "${runtime_root}/writes-enabled" 8>&- 9>&- \
    || ! sync_path "${runtime_root}"; then
    rm -f -- "${temporary}" 8>&- 9>&-
    return 1
  fi
}

transaction_owner_context_is_valid() {
  [[ ${tx_version} == 2 ]] || return 1
  [[ $(< /proc/sys/kernel/random/boot_id) == "${tx_owner_boot_id}" ]] || return 1
  [[ $(stat -c '%d:%i' -- "${lock_file}" 8>&- 9>&-) == "${tx_lock_identity}" ]] || return 1
}

transaction_owner_is_active() {
  transaction_owner_context_is_valid || return 1
  [[ -r /proc/${tx_owner_pid}/stat ]] || return 1
  [[ $(awk '{print $22}' "/proc/${tx_owner_pid}/stat" 8>&- 9>&-) == "${tx_owner_starttime}" ]] || return 1
  if [[ ${test_mode} != 1 ]]; then
    local command_line
    command_line=$(tr '\0' ' ' < "/proc/${tx_owner_pid}/cmdline" 8>&- 9>&-) || return 1
    [[ ${command_line} == *'/usr/local/libexec/fireside-release/promote-release.sh'* ]] || return 1
  fi
}

process_group_is_empty() {
  local expected_group=$1 expected_session=$2 stat_file stat_line stat_tail
  local -a fields
  for stat_file in /proc/[0-9]*/stat; do
    [[ -r ${stat_file} ]] || continue
    IFS= read -r stat_line < "${stat_file}" || continue
    stat_tail=${stat_line##*) }
    [[ ${stat_tail} != "${stat_line}" ]] || return 1
    read -r -a fields <<< "${stat_tail}"
    [[ ${#fields[@]} -ge 4 ]] || return 1
    if [[ ${fields[2]} == "${expected_group}" && ${fields[3]} == "${expected_session}" ]]; then
      return 1
    fi
  done
  return 0
}

terminate_orphan_transaction_owner() {
  [[ ${tx_version} == 2 ]] || return 0
  [[ $(< /proc/sys/kernel/random/boot_id) == "${tx_owner_boot_id}" ]] || return 0
  transaction_owner_context_is_valid || return 1
  [[ ${tx_owner_pid} != $$ ]] || return 0
  process_group_is_empty "${tx_owner_pid}" "${tx_owner_pid}" && return 0
  local process_group session_id
  if [[ -r /proc/${tx_owner_pid}/stat ]]; then
    transaction_owner_is_active || return 1
    read -r process_group session_id < <(awk '{print $5, $6}' "/proc/${tx_owner_pid}/stat" 8>&- 9>&-) || return 1
    [[ ${process_group} == "${tx_owner_pid}" && ${session_id} == "${tx_owner_pid}" ]] || return 1
  fi
  kill -TERM -- "-${tx_owner_pid}" 2>/dev/null || process_group_is_empty "${tx_owner_pid}" "${tx_owner_pid}" || return 1
  local attempt
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    process_group_is_empty "${tx_owner_pid}" "${tx_owner_pid}" && return 0
    sleep 0.1 8>&- 9>&-
  done
  kill -KILL -- "-${tx_owner_pid}" 2>/dev/null || process_group_is_empty "${tx_owner_pid}" "${tx_owner_pid}" || return 1
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    process_group_is_empty "${tx_owner_pid}" "${tx_owner_pid}" && return 0
    sleep 0.1 8>&- 9>&-
  done
  return 1
}

issue_service_permit() {
  local from_commit=$1 to_commit=$2 original_previous=$3 mode=$4 phase=$5 database_backup=$6
  local expected_commit=$7 purpose=$8
  read_transaction || return 1
  [[ ${tx_transaction_id} == "${transaction_id}" ]] || return 1
  adopt_transaction_identity
  transaction_permit_generation=$((transaction_permit_generation + 1))
  transaction_permit_commit=${expected_commit}
  transaction_permit_purpose=${purpose}
  transaction_permit_state=pending
  write_transaction "${from_commit}" "${to_commit}" "${original_previous}" "${mode}" "${phase}" "${database_backup}"
}

require_service_permit_consumed() {
  read_transaction || return 1
  [[ ${tx_transaction_id} == "${transaction_id}" \
    && ${tx_permit_commit} == "$1" \
    && ${tx_permit_purpose} == "$2" \
    && ${tx_permit_state} == consumed ]]
}

consume_service_permit() {
  read_transaction || return 1
  transaction_owner_is_active || return 1
  [[ ${tx_permit_state} == pending ]] || return 1
  case "${tx_permit_purpose}:${tx_phase}" in
    target:switched) [[ ${tx_permit_commit} == "${tx_to}" ]] || return 1 ;;
    recovery:reverting) [[ ${tx_mode} != bootstrap && ${tx_permit_commit} == "${tx_from}" ]] || return 1 ;;
    *) return 1 ;;
  esac
  local expected="${releases_root}/${tx_permit_commit}"
  [[ $(release_resolve_link "${current_link}" "${releases_root}") == "${expected}" ]] || return 1
  adopt_transaction_identity
  transaction_permit_state=consumed
  write_transaction "${tx_from}" "${tx_to}" "${tx_previous}" "${tx_mode}" "${tx_phase}" "${tx_database_backup}" || return 1
  set_runtime_selector "${expected}"
}

restart_service_authorized() {
  local from_commit=$1 to_commit=$2 original_previous=$3 mode=$4 phase=$5 database_backup=$6
  local expected_path=$7 purpose=$8
  local expected_commit=${expected_path##*/}
  issue_service_permit "${from_commit}" "${to_commit}" "${original_previous}" "${mode}" "${phase}" "${database_backup}" "${expected_commit}" "${purpose}" || return 1
  local reacquire_gate=0
  if [[ ${gate_mutex_held} == 1 ]]; then
    release_gate_mutex
    reacquire_gate=1
  fi
  if ! restart_service "${expected_path}"; then
    if [[ ${reacquire_gate} == 1 ]]; then acquire_gate_mutex || return 1; fi
    return 1
  fi
  if [[ ${reacquire_gate} == 1 ]]; then acquire_gate_mutex || return 1; fi
  if [[ ${test_mode} == 1 ]]; then
    read_transaction || return 1
    adopt_transaction_identity
    transaction_permit_state=consumed
    write_transaction "${tx_from}" "${tx_to}" "${tx_previous}" "${tx_mode}" "${tx_phase}" "${tx_database_backup}" || return 1
    set_runtime_selector "${expected_path}" || return 1
  fi
  require_service_permit_consumed "${expected_commit}" "${purpose}"
}

restore_previous_pointer() {
  local previous_commit=$1
  if [[ ${previous_commit} == none ]]; then
    rm -f -- "${previous_link}" || return 1
  else
    release_atomic_link "${releases_root}/${previous_commit}" "${previous_link}" || return 1
  fi
  sync_path "$(dirname -- "${previous_link}")"
}

restart_service() {
  local expected=$1
  if [[ ${test_mode} == 1 ]]; then
    "${FIRESIDE_RELEASE_RESTART_HOOK:?test restart hook is required}" "${expected}" 8>&- 9>&-
  else
    release_systemctl restart fireside.service 8>&- 9>&-
  fi
}

stop_workload() {
  if [[ ${test_mode} == 1 ]]; then
    "${FIRESIDE_RELEASE_STOP_HOOK:?test stop hook is required}" 8>&- 9>&-
  else
    release_systemctl stop fireside.service fireside.socket 8>&- 9>&-
  fi
}

bootstrap_pending_path() {
  printf '%s\n' "${database_path}.bootstrap-pending"
}

clear_bootstrap_pending() {
  local pending
  pending=$(bootstrap_pending_path) || return 1
  if [[ ! -e ${pending} && ! -L ${pending} ]]; then return 0; fi
  release_require_regular_file "${pending}" || return 1
  if [[ ${test_mode} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a:%h' -- "${pending}") == root:root:600:1 ]] || return 1
  else
    [[ $(stat -c '%h' -- "${pending}" 8>&- 9>&-) == 1 ]] || return 1
  fi
  rm -f -- "${pending}" 8>&- 9>&- || return 1
  sync_path "$(dirname -- "${database_path}")"
}

verify_bootstrap_backup() {
  [[ ${tx_database_backup} != none ]] || return 0
  local backup="${backup_directory}/${tx_database_backup}"
  local expected_size=${transaction_database_backup_size}
  local expected_sha256=${transaction_database_backup_sha256}
  if [[ ${tx_database_backup_size:-none} != none || ${tx_database_backup_sha256:-none} != none ]]; then
    expected_size=${tx_database_backup_size}
    expected_sha256=${tx_database_backup_sha256}
  fi
  [[ ${expected_size} =~ ^[1-9][0-9]*$ && ${expected_sha256} =~ ^[0-9a-f]{64}$ ]] || return 1
  release_assert_child_path "${backup_directory}" "${backup}" || return 1
  release_require_regular_file "${backup}" || return 1
  if [[ ${test_mode} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a:%h' -- "${backup}") == root:root:600:1 ]] || return 1
  else
    [[ $(stat -c '%h' -- "${backup}" 8>&- 9>&-) == 1 ]] || return 1
  fi
  [[ $(stat -c '%s' -- "${backup}" 8>&- 9>&-) == "${expected_size}" ]] || return 1
  [[ $(sha256sum -- "${backup}" 8>&- 9>&- | awk '{print $1}' 8>&- 9>&-) == "${expected_sha256}" ]]
}

install_bootstrap_database() {
  local source=$1
  local database_parent temporary
  database_parent=$(dirname -- "${database_path}") || return 1
  release_assert_child_path "${database_parent}" "${database_path}" || return 1
  temporary=$(bootstrap_pending_path) || return 1
  release_assert_child_path "${database_parent}" "${temporary}" || return 1
  clear_bootstrap_pending || return 1
  install -o root -g root -m 0600 -- "${source}" "${temporary}" 8>&- 9>&- || return 1
  if [[ ${source} == "${backup_directory}/"* && ${tx_database_backup} != none ]]; then
    [[ $(stat -c '%s' -- "${temporary}") == "${transaction_database_backup_size}" \
      && $(sha256sum -- "${temporary}" | awk '{print $1}') == "${transaction_database_backup_sha256}" ]] \
      || { clear_bootstrap_pending; return 1; }
  fi
  sync_path "${temporary}" || return 1
  rm -f -- "${database_path}-wal" "${database_path}-shm" "${database_path}-journal" 8>&- 9>&- \
    || return 1
  sync_path "${database_parent}" || return 1
  mv -Tf -- "${temporary}" "${database_path}" 8>&- 9>&- || return 1
  if [[ ${test_mode} != 1 ]]; then chown fireside:fireside "${database_path}" 8>&- 9>&- || return 1; fi
  chmod 0600 "${database_path}" 8>&- 9>&- || return 1
  sync_path "${database_path}" || return 1
  sync_path "${database_parent}"
}

restore_bootstrap_database() {
  local database_parent backup
  database_parent=$(dirname -- "${database_path}") || return 1
  release_assert_child_path "${database_parent}" "${database_path}" || return 1
  clear_bootstrap_pending || return 1
  rm -f -- "${database_path}-wal" "${database_path}-shm" "${database_path}-journal" 8>&- 9>&- || return 1
  if [[ ${tx_database_backup} == none ]]; then
    rm -f -- "${database_path}" 8>&- 9>&- || return 1
    sync_path "${database_parent}" || return 1
    return 0
  fi
  backup="${backup_directory}/${tx_database_backup}"
  verify_bootstrap_backup || return 1
  install_bootstrap_database "${backup}"
}

remove_bootstrap_pointer() {
  if [[ -L ${current_link} ]]; then
    rm -f -- "${current_link}" 8>&- 9>&- || return 1
  elif [[ -e ${current_link} ]]; then
    release_die 'bootstrap current pointer is not a symbolic link'
    return 1
  fi
  if [[ -L ${previous_link} ]]; then
    rm -f -- "${previous_link}" 8>&- 9>&- || return 1
  elif [[ -e ${previous_link} ]]; then
    release_die 'bootstrap previous pointer is not a symbolic link'
    return 1
  fi
  if [[ -e ${runtime_root}/current || -L ${runtime_root}/current ]]; then
    rm -f -- "${runtime_root}/current" 8>&- 9>&- || return 1
    sync_path "${runtime_root}" || return 1
  fi
  sync_path "$(dirname -- "${current_link}")"
}

recover_bootstrap_transaction() {
  local skip_stop=${1:-0}
  verify_bootstrap_backup || return 4
  clear_bootstrap_pending || return 4
  if [[ ${skip_stop} != 1 ]]; then stop_workload || return 4; fi
  revoke_write_permit || return 4
  remove_bootstrap_pointer || return 4
  restore_bootstrap_database || return 4
  local marker="${state_root}/${tx_to}.healthy"
  if [[ -e ${marker} || -L ${marker} ]]; then
    rm -f -- "${marker}" 8>&- 9>&- || return 4
    sync_path "${state_root}" || return 4
  fi
  clear_transaction || return 4
}

recover_committed_transaction() {
  local target="${releases_root}/${tx_to}"
  [[ $(release_resolve_link "${current_link}" "${releases_root}") == "${target}" ]] || return 4
  release_require_healthy_marker "${state_root}" "${target}" || return 4
  if [[ ${tx_mode} == bootstrap ]]; then
    [[ ! -e ${previous_link} && ! -L ${previous_link} ]] || return 4
  else
    [[ $(release_resolve_link "${previous_link}" "${releases_root}") == "${releases_root}/${tx_from}" ]] || return 4
  fi
  set_runtime_selector "${target}" || return 4
  publish_write_permit "${tx_to}" || return 4
  clear_transaction || return 4
  echo "completed committed Fireside ${tx_mode} transaction to ${tx_to}"
}

release_is_explicit_legacy_runtime() {
  local release_path=$1
  [[ ! -e ${release_path}/RELEASE_COMMIT && ! -L ${release_path}/RELEASE_COMMIT \
    && ! -e ${release_path}/RELEASE_METADATA && ! -L ${release_path}/RELEASE_METADATA \
    && ! -e ${release_path}/RELEASE_MANIFEST.sha256 && ! -L ${release_path}/RELEASE_MANIFEST.sha256 ]]
}

read_legacy_process_cwd() {
  local pid=$1
  [[ ${pid} =~ ^[1-9][0-9]*$ ]] || return 1
  release_systemd_run --quiet --wait --collect --pipe --service-type=exec \
    --unit="fireside-cwd-check-${pid}-$$-${RANDOM}" \
    -p User=fireside -p Group=fireside -p NoNewPrivileges=yes \
    -p CapabilityBoundingSet= -p AmbientCapabilities= \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
    -p PrivateNetwork=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
    -p ProtectKernelLogs=yes -p ProtectControlGroups=yes -p ProtectClock=yes \
    -p ProtectHostname=yes -p RestrictSUIDSGID=yes -p RestrictNamespaces=yes \
    -p ProtectProc=ptraceable -p ProcSubset=pid -p RestrictAddressFamilies=AF_UNIX \
    -p InaccessiblePaths=/etc/fireside.env -p TimeoutStartSec=10s -- \
    /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/readlink -f "/proc/${pid}/cwd" 8>&- 9>&-
}

check_live_release() {
  local expected=$1
  if [[ ${test_mode} == 1 ]]; then
    "${FIRESIDE_RELEASE_HEALTH_HOOK:?test health hook is required}" "${expected}" 8>&- 9>&-
    return
  fi
  local stable_pid= attempt response pid cwd uid identity_ok expected_commit service_uid
  expected_commit=${expected##*/}
  release_require_full_commit "${expected_commit}" || return 1
  service_uid=$(id -u fireside 8>&- 9>&-) || return 1
  for ((attempt = 0; attempt < 15; attempt += 1)); do
    if release_units_are_active release_systemctl 8>&- 9>&-; then
      pid=$(release_systemctl show fireside.service -p MainPID --value 8>&- 9>&-)
      if [[ ${pid} =~ ^[1-9][0-9]*$ && -d /proc/${pid} ]]; then
        uid=$(awk '/^Uid:/{print $2}' "/proc/${pid}/status" 2>/dev/null || true)
        response=$(release_fetch_health http://127.0.0.1/api/health 8>&- 9>&- 2>/dev/null || true)
        identity_ok=0
        if printf '%s' "${response}" | /usr/bin/jq -e --arg commit "${expected_commit}" \
          '.ok == true and .releaseCommit == $commit' >/dev/null 2>&1; then
          identity_ok=1
        elif release_is_explicit_legacy_runtime "${expected}" \
          && printf '%s' "${response}" | /usr/bin/jq -e '.ok == true and (.releaseCommit | not)' >/dev/null 2>&1; then
          cwd=$(read_legacy_process_cwd "${pid}" 2>/dev/null || true)
          [[ ${cwd} == "${expected}" ]] && identity_ok=1
        fi
        if [[ ${identity_ok} == 1 && ${uid} == "${service_uid}" ]]; then
          if [[ -z ${stable_pid:-} ]]; then
            stable_pid=${pid}
          elif [[ ${stable_pid} == "${pid}" ]]; then
            return 0
          else
            stable_pid=${pid}
          fi
        else
          stable_pid=
        fi
      fi
    fi
    sleep 1 8>&- 9>&-
  done
  return 1
}

service_main_pid_is_zero() {
  local main_pid
  if [[ ${test_mode} == 1 ]]; then
    if [[ -n ${FIRESIDE_RELEASE_MAIN_PID_HOOK:-} ]]; then
      main_pid=$("${FIRESIDE_RELEASE_MAIN_PID_HOOK}" 8>&- 9>&-) || return 1
    else
      main_pid=0
    fi
  else
    main_pid=$(release_systemctl show --property=MainPID --value fireside.service 8>&- 9>&-) || return 1
  fi
  [[ ${main_pid} =~ ^[0-9]+$ && ${main_pid} == 0 ]]
}

recover_transaction() {
  local boot_mode=${1:-0}
  if [[ ! -e ${journal_file} && ! -L ${journal_file} ]]; then
    clear_release_active
    return $?
  fi
  if ! read_transaction; then
    release_die 'release transaction journal is invalid; refusing automatic mutation'
    return 4
  fi
  if [[ ${boot_mode} != 0 ]] && ! service_main_pid_is_zero; then
    release_die 'no-restart recovery requires fireside.service MainPID=0'
    return 4
  fi
  if [[ ${tx_version} == 2 && ${tx_owner_pid} != $$ ]]; then
    terminate_orphan_transaction_owner || return 4
    read_transaction || return 4
  fi
  adopt_transaction_identity
  if [[ ${tx_phase} == committed ]]; then
    recover_committed_transaction
    return $?
  fi
  if [[ ${tx_mode} == bootstrap ]]; then
    recover_bootstrap_transaction "$([[ ${boot_mode} == 2 ]] && printf 1 || printf 0)" || return 4
    echo "recovered interrupted Fireside bootstrap to an uninitialized state"
    return 0
  fi
  local from_path="${releases_root}/${tx_from}"
  release_validate_runtime_tree "${from_path}" || return 4
  release_atomic_link "${from_path}" "${current_link}" || return 4
  sync_path "$(dirname -- "${current_link}")" || return 4
  restore_previous_pointer "${tx_previous}" || return 4
  if [[ ${boot_mode} == 0 ]]; then
    if [[ ${transaction_id} == legacy ]]; then begin_transaction_identity || return 4; fi
    take_transaction_ownership || return 4
    transaction_permit_commit=none
    transaction_permit_purpose=none
    transaction_permit_state=none
    write_transaction "${tx_from}" "${tx_to}" "${tx_previous}" "${tx_mode}" reverting "${tx_database_backup}" || return 4
    restart_service_authorized "${tx_from}" "${tx_to}" "${tx_previous}" "${tx_mode}" reverting "${tx_database_backup}" "${from_path}" recovery || return 4
    check_live_release "${from_path}" || return 4
  fi
  set_runtime_selector "${from_path}" || return 4
  publish_write_permit "${tx_from}" || return 4
  clear_transaction || return 4
  echo "recovered interrupted Fireside ${tx_mode} transaction to ${tx_from}"
}

latest_backup() {
  local entry basename newest= newest_key= key owner mode links
  while IFS= read -r -d '' entry; do
    basename=${entry##*/}
    [[ ${basename} =~ ^fireside-backup-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{16}\.sqlite3$ ]] || continue
    [[ -f ${entry} && ! -L ${entry} ]] || continue
    if [[ ${test_mode} != 1 ]]; then
      owner=$(stat -c %U "${entry}")
      mode=$(stat -c %a "${entry}")
      links=$(stat -c %h "${entry}")
      [[ ${owner} == root && ${mode} == 600 && ${links} == 1 ]] || continue
    fi
    key=$(stat -c '%Y:%n' "${entry}")
    if [[ -z ${newest_key} || ${key} > ${newest_key} ]]; then newest=${entry}; newest_key=${key}; fi
  done < <(find "${backup_directory}" -maxdepth 1 -mindepth 1 -print0)
  [[ -n ${newest} ]] || return 1
  printf '%s\n' "${newest}"
}

create_release_backup() {
  local backup_runner=$1
  local before after
  before=$(latest_backup 2>/dev/null || true)
  if [[ ${test_mode} == 1 ]]; then
    "${FIRESIDE_RELEASE_BACKUP_HOOK:?test backup hook is required}" "${backup_directory}" "${backup_runner}" 8>&- 9>&- || return 1
  else
    release_systemd_run --quiet --wait --collect --pipe --service-type=exec \
      --unit="fireside-release-backup-$$" \
      -p User=root -p Group=root -p NoNewPrivileges=yes \
      -p CapabilityBoundingSet=CAP_DAC_READ_SEARCH -p AmbientCapabilities=CAP_DAC_READ_SEARCH \
      -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
      -p PrivateNetwork=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
      -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p RestrictNamespaces=yes \
      -p InaccessiblePaths=/etc/fireside.env \
      -p RestrictAddressFamilies=AF_UNIX -p ReadOnlyPaths=/var/lib/fireside \
      -p ReadWritePaths=/var/backups/fireside -p TimeoutStartSec=5min -- \
      /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production \
        DATABASE_PATH=/var/lib/fireside/fireside.db BACKUP_DIRECTORY=/var/backups/fireside \
        BACKUP_RETENTION=14 /usr/bin/node "${backup_runner}/server-build/server/backup-cli.js" 8>&- 9>&- >/dev/null || return 1
  fi
  after=$(latest_backup) || return 1
  [[ ${after} != "${before}" ]] || return 1
  printf '%s\n' "${after}"
}

run_release_preflight() {
  local release_path=$1 database_path=$2 mode=${3:-verify}
  local output sandbox_database
  if [[ ${test_mode} == 1 ]]; then
    output=$("${FIRESIDE_RELEASE_PREFLIGHT_HOOK:?test preflight hook is required}" "${release_path}" "${database_path}" "${mode}" 8>&- 9>&-) || return 1
  else
    sandbox_database="/run/fireside-sensitive-preflight/${database_path##*/}"
    output=$(release_systemd_run --quiet --wait --collect --pipe --service-type=exec \
      --unit="fireside-sensitive-preflight-release-${release_path##*/}-$$-${RANDOM}" \
      -p "User=${build_user}" -p "Group=${build_user}" -p PrivateNetwork=yes \
      -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes \
      -p PrivateTmp=yes -p PrivateDevices=yes -p RestrictSUIDSGID=yes \
      -p InaccessiblePaths='/var/lib/fireside /var/backups/fireside /etc/fireside.env' \
      -p "BindPaths=$(dirname -- "${database_path}"):/run/fireside-sensitive-preflight" \
      -p TimeoutStartSec=2min -p RuntimeMaxSec=2min -- \
      /usr/bin/env -i HOME=/nonexistent PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production \
        FIRESIDE_PREFLIGHT_RELEASE="${release_path}" DATABASE_PATH="${sandbox_database}" \
        FIRESIDE_PREFLIGHT_MODE="${mode}" \
        FIRESIDE_WRITE_KEY='release-preflight-only-key-32chars' \
        /usr/bin/node "${script_dir}/release-preflight.mjs" 8>&- 9>&-) || return 1
  fi
  printf '%s\n' "${output}" | /usr/bin/jq -ce '
    select(
      .ok == true
      and (.topicCount | type == "number" and . >= 0 and floor == .)
      and (.participantCount | type == "number" and . >= 0 and floor == .)
      and (.orderVersion | type == "number" and . >= 0 and floor == .)
      and (.revisionsSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.sensitivePresenceSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.businessDataSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    )
    | {
      topicCount,
      participantCount,
      orderVersion,
      revisionsSha256,
      sensitivePresenceSha256,
      businessDataSha256
    }
  '
}

rollback_after_failure() {
  local from_path=$1 original_previous=$2
  local from_commit=${from_path##*/}
  release_atomic_link "${from_path}" "${current_link}" || return 4
  sync_path "$(dirname -- "${current_link}")" || return 4
  transaction_permit_commit=none
  transaction_permit_purpose=none
  transaction_permit_state=none
  write_transaction "${from_commit}" "${commit}" "${original_previous}" "${mode}" reverting none || return 4
  restart_service_authorized "${from_commit}" "${commit}" "${original_previous}" "${mode}" reverting none "${from_path}" recovery || return 4
  check_live_release "${from_path}" || return 4
  restore_previous_pointer "${original_previous}" || return 4
  set_runtime_selector "${from_path}" || return 4
  publish_write_permit "${from_commit}" || return 4
  clear_transaction || return 4
  return 3
}

rollback_bootstrap_after_failure() {
  if recover_bootstrap_transaction; then
    return 3
  fi
  return 4
}

rebuild_runtime_from_current() {
  local selected commit
  selected=$(release_resolve_link "${current_link}" "${releases_root}") || return 1
  commit=${selected##*/}
  release_require_healthy_marker "${state_root}" "${selected}" || return 1
  set_runtime_selector "${selected}" || return 1
  publish_write_permit "${commit}" || return 1
  clear_release_active
}

service_start_gate_with_lock() {
  if [[ -e ${journal_file} || -L ${journal_file} ]]; then
    recover_transaction 2 || return 1
  fi
  rebuild_runtime_from_current
}

service_start_gate_during_transaction() {
  consume_service_permit
}

backup_start_gate_with_lock() {
  if [[ -e ${journal_file} || -L ${journal_file} ]]; then
    recover_transaction 0 || return 1
  fi
  rebuild_runtime_from_current
}

if [[ ${production_mode} == 1 \
  && ( ${lock_file} != /run/fireside-release.lock || ${gate_lock_file} != /run/fireside-release-gate.lock ) ]]; then
  release_die 'production release lock path is invalid'
  exit 2
fi
release_prepare_lock_file "${lock_file}" "${EUID}" "$(id -g)" || exit 2
main_lock_state=unwrapped
if [[ ${1:-} == --main-lock-held ]]; then
  main_lock_state=held
  shift
elif [[ ${1:-} == --main-lock-busy ]]; then
  main_lock_state=busy
  shift
fi

if [[ ${main_lock_state} == unwrapped ]]; then
  if [[ ${1:-} == --watchdog ]]; then
    watchdog_transaction=${2:-}
    [[ ${watchdog_transaction} =~ ^[0-9a-f]{32}$ && $# -eq 2 ]] \
      || { release_die 'invalid release watchdog transaction'; exit 2; }
    if [[ ! -e ${journal_file} && ! -L ${journal_file} ]]; then exit 0; fi
    read_transaction || { release_die 'release watchdog cannot read the prepared transaction'; exit 4; }
    [[ ${tx_version} == 2 && ${tx_transaction_id} == "${watchdog_transaction}" ]] \
      || { release_die 'release watchdog transaction identity is invalid'; exit 4; }
    transaction_owner_context_is_valid \
      || { release_die 'release watchdog owner context is invalid'; exit 4; }
    if [[ ${test_mode} != 1 ]]; then
      /usr/bin/systemd-notify --pid=parent --ready --status="waiting for Fireside transaction ${watchdog_transaction}" \
        || { release_die 'cannot signal release watchdog readiness'; exit 4; }
    fi
    exec flock -x -w 900 --close "${lock_file}" /usr/bin/setsid "${script_path}" --main-lock-held "$@"
  fi
  if [[ ${1:-} == --service-gate ]]; then
    [[ $# -eq 1 ]] || { release_die 'unexpected service gate arguments'; exit 2; }
    flock -E 75 -x -n --close "${lock_file}" /usr/bin/setsid "${script_path}" --main-lock-held "$@"
    result=$?
    if [[ ${result} == 75 ]]; then exec "${script_path}" --main-lock-busy "$@"; fi
    exit "${result}"
  fi
  lock_wait=(-n)
  if [[ ${1:-} == --recover && ${2:-} == --boot ]] || [[ ${1:-} == --backup-gate ]]; then lock_wait=(-w 120); fi
  exec flock -E 75 -x "${lock_wait[@]}" --close "${lock_file}" /usr/bin/setsid "${script_path}" --main-lock-held "$@"
fi

if [[ ${main_lock_state} == held ]]; then
  if ! release_cleanup_sensitive_preflights "${sensitive_preflight_root}" "${build_user}"; then
    case "${1:-}" in
      --service-gate|--backup-gate|--watchdog|--recover) exit 4 ;;
      *) exit 2 ;;
    esac
  fi
fi

if [[ ${main_lock_state} == busy ]]; then
  [[ ${1:-} == --service-gate && $# -eq 1 ]] || { release_die 'invalid busy-lock invocation'; exit 2; }
  if flock -E 75 -x -n --close "${lock_file}" /usr/bin/true; then
    exec "${script_path}" --service-gate
  fi
  acquire_gate_mutex || exit 4
  service_start_gate_during_transaction || exit 4
  release_gate_mutex
  exit 0
fi

if [[ ${1:-} == --service-gate ]]; then
  [[ $# -eq 1 ]] || { release_die 'unexpected service gate arguments'; exit 2; }
  acquire_gate_mutex || exit 4
  service_start_gate_with_lock || exit 4
  release_gate_mutex
  exit 0
fi
if [[ ${1:-} == --backup-gate ]]; then
  [[ $# -eq 1 ]] || { release_die 'unexpected backup gate arguments'; exit 2; }
  acquire_gate_mutex || exit 4
  backup_start_gate_with_lock || exit 4
  release_gate_mutex
  exit 0
fi

if [[ ${1:-} == --watchdog ]]; then
  acquire_gate_mutex || exit 4
  if [[ ! -e ${journal_file} && ! -L ${journal_file} ]]; then
    clear_release_active || exit 4
    release_gate_mutex
    exit 0
  fi
  read_transaction || exit 4
  if [[ ${tx_transaction_id} != "${watchdog_transaction}" ]]; then
    release_gate_mutex
    exit 0
  fi
  recover_transaction 0
  result=$?
  release_gate_mutex
  exit ${result}
fi

if [[ ${1:-} == --recover ]]; then
  boot_mode=0
  if [[ ${2:-} == --boot ]]; then
    boot_mode=1
    [[ $# -eq 2 ]] || { release_die 'unexpected recovery arguments'; exit 2; }
  else
    [[ $# -eq 1 ]] || { release_die 'unexpected recovery arguments'; exit 2; }
  fi
  acquire_gate_mutex || exit 4
  recover_transaction "${boot_mode}"
  result=$?
  release_gate_mutex
  exit ${result}
fi

acquire_gate_mutex || exit 4
recover_transaction 0
recovery_result=$?
release_gate_mutex
[[ ${recovery_result} == 0 ]] || exit "${recovery_result}"

mode=promote
if [[ ${1:-} == --rollback ]]; then
  mode=rollback
  shift
elif [[ ${1:-} == --bootstrap ]]; then
  mode=bootstrap
  shift
fi
commit=${1:-}
if [[ ${mode} == rollback && ${commit} == --previous ]]; then
  target=$(release_resolve_link "${previous_link}" "${releases_root}") \
    || { release_die 'no previous healthy release is recorded'; exit 2; }
  commit=${target##*/}
fi
release_require_full_commit "${commit}" || exit 2
[[ $# -eq 1 ]] || { release_die 'unexpected release arguments'; exit 2; }
target="${releases_root}/${commit}"
if [[ ${mode} == rollback ]]; then
  release_require_healthy_marker "${state_root}" "${target}" || exit 2
else
  release_verify_manifest "${target}" "${commit}" || exit 2
fi

if [[ ${mode} == bootstrap ]]; then
  if [[ -e ${current_link} || -L ${current_link} || -e ${previous_link} || -L ${previous_link} ]]; then
    release_die 'bootstrap requires current and previous pointers to be absent'
    exit 2
  fi
  database_parent=$(dirname -- "${database_path}") || exit 2
  [[ -d ${database_parent} && ! -L ${database_parent} ]] \
    || { release_die 'bootstrap database directory is not a real directory'; exit 2; }
  [[ -d ${backup_directory} && ! -L ${backup_directory} ]] \
    || { release_die 'bootstrap backup directory is not a real directory'; exit 2; }
  stop_workload || { release_die 'cannot stop Fireside before bootstrap'; exit 2; }

  bootstrap_backup=none
  if [[ -e ${database_path} || -L ${database_path} ]]; then
    release_require_regular_file "${database_path}" || exit 2
    if [[ ${test_mode} != 1 ]]; then
      [[ $(stat -c '%U:%G:%a:%h' -- "${database_path}") == fireside:fireside:600:1 ]] \
        || { release_die 'bootstrap database permissions are invalid'; exit 2; }
    fi
    backup=$(create_release_backup "${target}") \
      || { release_die 'bootstrap backup failed; no release pointer was created'; exit 2; }
    bootstrap_backup=${backup##*/}
  elif [[ -e ${database_path}-wal || -L ${database_path}-wal \
    || -e ${database_path}-shm || -L ${database_path}-shm \
    || -e ${database_path}-journal || -L ${database_path}-journal ]]; then
    release_die 'bootstrap refuses orphan database sidecar files'
    exit 2
  fi

  if ! preflight_stage=$(mktemp -d "${sensitive_preflight_root}/bootstrap.${commit}.XXXXXXXX"); then
    release_die 'cannot create the isolated bootstrap preflight directory'
    exit 2
  fi
  release_assert_child_path "${sensitive_preflight_root}" "${preflight_stage}" || exit 2
  cleanup_preflight() {
    if [[ -n ${preflight_stage:-} && ${preflight_stage} == "${sensitive_preflight_root}/bootstrap."* && -d ${preflight_stage} ]]; then
      if [[ ${test_mode} == 1 && -n ${FIRESIDE_RELEASE_CLEANUP_HOOK:-} ]]; then
        "${FIRESIDE_RELEASE_CLEANUP_HOOK}" "${preflight_stage}" || return 1
      else
        rm -rf -- "${preflight_stage}" || return 1
      fi
      [[ ! -e ${preflight_stage} && ! -L ${preflight_stage} ]] || return 1
    fi
  }
  cleanup_preflight_on_exit() {
    local original_status=$?
    if ! cleanup_preflight; then
      release_die 'bootstrap preflight cleanup failed; manual cleanup is required'
    fi
    return "${original_status}"
  }
  trap cleanup_preflight_on_exit EXIT
  chmod 0700 "${preflight_stage}" \
    || { release_die 'cannot protect the bootstrap preflight directory'; exit 2; }
  preflight_database="${preflight_stage}/fireside.db"
  release_assert_child_path "${preflight_stage}" "${preflight_database}" || exit 2
  if [[ ${bootstrap_backup} != none ]]; then
    install -m 0600 -- "${backup}" "${preflight_database}" \
      || { release_die 'cannot copy the bootstrap backup into preflight'; exit 2; }
  fi
  if [[ ${test_mode} != 1 ]]; then
    chown -R "${build_user}:${build_user}" "${preflight_stage}" \
      || { release_die 'cannot assign the bootstrap preflight directory'; exit 2; }
  fi
  run_release_preflight "${target}" "${preflight_database}" migrate >/dev/null \
    || { release_die 'bootstrap database preflight failed; no release pointer was created'; exit 2; }
  release_require_regular_file "${preflight_database}" || exit 2

  tx_to=${commit}
  tx_database_backup=${bootstrap_backup}
  if [[ ${bootstrap_backup} != none ]]; then
    transaction_database_backup_size=$(stat -c '%s' -- "${backup}") || exit 2
    transaction_database_backup_sha256=$(sha256sum -- "${backup}" | awk '{print $1}') || exit 2
    [[ ${transaction_database_backup_size} =~ ^[1-9][0-9]*$ \
      && ${transaction_database_backup_sha256} =~ ^[0-9a-f]{64}$ ]] || exit 2
  fi
  begin_transaction_identity || exit 2
  if [[ ${bootstrap_backup} != none ]]; then
    transaction_database_backup_size=$(stat -c '%s' -- "${backup}") || exit 2
    transaction_database_backup_sha256=$(sha256sum -- "${backup}" | awk '{print $1}') || exit 2
    verify_bootstrap_backup || { release_die 'bootstrap backup identity changed before journaling'; exit 2; }
  fi
  write_transaction none "${commit}" none bootstrap prepared "${bootstrap_backup}" || exit 2
  if ! start_transaction_watchdog "${transaction_id}"; then
    release_die 'cannot start the bootstrap recovery watchdog'
    if clear_transaction; then exit 2; else exit 4; fi
  fi
  if ! mark_release_active "${transaction_id}" || ! revoke_write_permit; then
    release_die 'cannot establish the bootstrap write barrier; restoring the uninitialized state'
    rollback_bootstrap_after_failure
    exit $?
  fi
  if ! install_bootstrap_database "${preflight_database}"; then
    release_die 'cannot install the bootstrap database; restoring the uninitialized state'
    rollback_bootstrap_after_failure
    exit $?
  fi
  if ! cleanup_preflight; then
    release_die 'cannot remove the isolated bootstrap preflight directory; restoring the uninitialized state'
    rollback_bootstrap_after_failure
    exit $?
  fi
  preflight_stage=
  trap - EXIT
  if ! release_atomic_link "${target}" "${current_link}" || ! sync_path "$(dirname -- "${current_link}")"; then
    rollback_bootstrap_after_failure
    exit $?
  fi
  write_transaction none "${commit}" none bootstrap switched "${bootstrap_backup}" || {
    rollback_bootstrap_after_failure
    exit $?
  }
  if ! restart_service_authorized none "${commit}" none bootstrap switched "${bootstrap_backup}" "${target}" target \
    || ! check_live_release "${target}"; then
    release_die 'bootstrap health gate failed; restoring the uninitialized state'
    rollback_bootstrap_after_failure
    exit $?
  fi
  write_transaction none "${commit}" none bootstrap healthy "${bootstrap_backup}" || {
    rollback_bootstrap_after_failure
    exit $?
  }
  release_mark_healthy "${state_root}" "${target}" || {
    rollback_bootstrap_after_failure
    exit $?
  }
  sync_path "${state_root}" || {
    rollback_bootstrap_after_failure
    exit $?
  }
  transaction_permit_commit=none
  transaction_permit_purpose=none
  transaction_permit_state=none
  write_transaction none "${commit}" none bootstrap committed "${bootstrap_backup}" || {
    rollback_bootstrap_after_failure
    exit $?
  }
  publish_write_permit "${commit}" \
    || { release_die 'bootstrap committed but write permission could not be published'; exit 4; }
  clear_transaction \
    || { release_die 'bootstrap committed but transaction cleanup requires recovery'; exit 4; }
  echo "bootstrapped Fireside release ${commit}; previous is none"
  exit 0
fi

origin=$(release_resolve_link "${current_link}" "${releases_root}") || exit 2
if [[ ${origin} == "${target}" ]]; then
  check_live_release "${target}" || exit 2
  echo "Fireside release ${commit} is already current and healthy"
  exit 0
fi
if release_is_explicit_legacy_runtime "${origin}"; then
  release_normalize_explicit_legacy_dependencies "${origin}" || exit 2
fi
release_validate_runtime_tree "${origin}" || exit 2
check_live_release "${origin}" || { release_die 'current release is not healthy; refusing to record it as rollback target'; exit 2; }
release_mark_healthy "${state_root}" "${origin}" || exit 2
sync_path "${state_root}" || exit 2

original_previous=none
if [[ -L ${previous_link} ]]; then
  original_previous_path=$(release_resolve_link "${previous_link}" "${releases_root}") || exit 2
  original_previous=${original_previous_path##*/}
elif [[ -e ${previous_link} ]]; then
  release_die 'previous pointer exists but is not a symbolic link'
  exit 2
fi

backup_runner=${target}
if [[ ${mode} == rollback ]]; then backup_runner=${origin}; fi
backup=$(create_release_backup "${backup_runner}") || { release_die 'release backup failed; current was not changed'; exit 2; }
if ! preflight_stage=$(mktemp -d "${sensitive_preflight_root}/promote.${commit}.XXXXXXXX"); then
  release_die 'cannot create the isolated promotion preflight directory'
  exit 2
fi
release_assert_child_path "${sensitive_preflight_root}" "${preflight_stage}" || exit 2
cleanup_preflight() {
  if [[ -n ${preflight_stage:-} && ${preflight_stage} == "${sensitive_preflight_root}/promote."* && -d ${preflight_stage} ]]; then
    if [[ ${test_mode} == 1 && -n ${FIRESIDE_RELEASE_CLEANUP_HOOK:-} ]]; then
      "${FIRESIDE_RELEASE_CLEANUP_HOOK}" "${preflight_stage}" || return 1
    else
      rm -rf -- "${preflight_stage}" || return 1
    fi
    [[ ! -e ${preflight_stage} && ! -L ${preflight_stage} ]] || return 1
  fi
}
cleanup_preflight_on_exit() {
  local original_status=$?
  if ! cleanup_preflight; then
    release_die 'promotion preflight cleanup failed; manual cleanup is required'
  fi
  return "${original_status}"
}
trap cleanup_preflight_on_exit EXIT
chmod 0700 "${preflight_stage}" || { release_die 'cannot protect the promotion preflight directory'; exit 2; }
preflight_database="${preflight_stage}/fireside.db"
release_assert_child_path "${preflight_stage}" "${preflight_database}" || exit 2
install -m 0600 "${backup}" "${preflight_database}" \
  || { release_die 'cannot copy the release backup into the isolated preflight directory'; exit 2; }
if [[ ${test_mode} != 1 ]]; then
  chown -R "${build_user}:${build_user}" "${preflight_stage}" \
    || { release_die 'cannot assign the isolated preflight directory'; exit 2; }
fi
baseline_fingerprint=$(run_release_preflight "${origin}" "${preflight_database}" verify) \
  || { release_die 'current database preflight failed; current was not changed'; exit 2; }
candidate_fingerprint=$(run_release_preflight "${target}" "${preflight_database}" migrate) \
  || { release_die 'candidate database preflight failed; current was not changed'; exit 2; }
[[ ${candidate_fingerprint} == "${baseline_fingerprint}" ]] \
  || { release_die 'candidate migration changed protected business fingerprints; current was not changed'; exit 2; }
rollback_fingerprint=$(run_release_preflight "${origin}" "${preflight_database}" verify) \
  || { release_die 'current release cannot read the candidate-migrated database; current was not changed'; exit 2; }
[[ ${rollback_fingerprint} == "${baseline_fingerprint}" ]] \
  || { release_die 'rollback compatibility changed protected business fingerprints; current was not changed'; exit 2; }
cleanup_preflight \
  || { release_die 'cannot remove the isolated promotion preflight directory'; exit 2; }
preflight_stage=
trap - EXIT

from_commit=${origin##*/}
begin_transaction_identity || exit 2
if ! write_transaction "${from_commit}" "${commit}" "${original_previous}" "${mode}" prepared; then
  exit 2
fi
if ! start_transaction_watchdog "${transaction_id}"; then
  release_die 'cannot start the release recovery watchdog'
  if clear_transaction; then exit 2; else exit 4; fi
fi
if ! mark_release_active "${transaction_id}" || ! revoke_write_permit; then
  release_die 'cannot establish the release write barrier; restoring the current release'
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
fi
if ! release_atomic_link "${target}" "${current_link}" || ! sync_path "$(dirname -- "${current_link}")"; then
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
fi
write_transaction "${from_commit}" "${commit}" "${original_previous}" "${mode}" switched || {
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
}
if ! restart_service_authorized "${from_commit}" "${commit}" "${original_previous}" "${mode}" switched none "${target}" target \
  || ! check_live_release "${target}"; then
  release_die "${mode} health gate failed; restoring ${from_commit}"
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
fi
write_transaction "${from_commit}" "${commit}" "${original_previous}" "${mode}" healthy || {
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
}
if ! release_atomic_link "${origin}" "${previous_link}" || ! sync_path "$(dirname -- "${previous_link}")"; then
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
fi
write_transaction "${from_commit}" "${commit}" "${original_previous}" "${mode}" previous || {
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
}
release_mark_healthy "${state_root}" "${target}" || {
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
}
sync_path "${state_root}" || {
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
}
transaction_permit_commit=none
transaction_permit_purpose=none
transaction_permit_state=none
write_transaction "${from_commit}" "${commit}" "${original_previous}" "${mode}" committed || {
  rollback_after_failure "${origin}" "${original_previous}"
  exit $?
}
publish_write_permit "${commit}" \
  || { release_die "${mode} committed but write permission could not be published"; exit 4; }
clear_transaction \
  || { release_die "${mode} committed but transaction cleanup requires recovery"; exit 4; }
echo "${mode}d Fireside release ${commit}; previous is ${from_commit}"
