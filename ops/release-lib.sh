#!/bin/bash -p

release_sanitize_environment() {
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  unset CDPATH ENV BASH_ENV HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR TMPDIR TMP TEMP
  unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH SSH_AUTH_SOCK SSH_AGENT_PID
  unset FIRESIDE_WRITE_KEY FIRESIDE_SESSION_KEY SESSION_SECRET
  local name
  while IFS= read -r name; do
    case "${name}" in
      GIT_*|DBUS_*|SYSTEMD_*|http_proxy|https_proxy|all_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)
        unset "${name}"
        ;;
    esac
  done < <(compgen -e)
}

release_git() {
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_NO_REPLACE_OBJECTS=1 \
    /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}

release_validate_authoritative_ssh_material() {
  local credential_root=/etc/fireside-release
  local identity_file=${credential_root}/github_readonly_ed25519
  local known_hosts_file=${credential_root}/github_known_hosts
  local metadata mode parent expected_known_host actual_known_host
  for parent in / /etc; do
    [[ -d ${parent} && ! -L ${parent} && $(stat -c '%u:%g' -- "${parent}") == 0:0 ]] \
      || { release_die "authoritative SSH parent is invalid: ${parent}"; return 1; }
    mode=$(stat -c '%a' -- "${parent}") || return 1
    (( (8#${mode} & 8#022) == 0 )) \
      || { release_die "authoritative SSH parent is writable by another identity: ${parent}"; return 1; }
  done
  [[ -d ${credential_root} && ! -L ${credential_root} ]] \
    || { release_die 'authoritative SSH credential directory is invalid'; return 1; }
  metadata=$(stat -c '%u:%g:%a' -- "${credential_root}") || return 1
  [[ ${metadata} == 0:0:700 ]] \
    || { release_die 'authoritative SSH credential directory metadata is invalid'; return 1; }
  local filename
  for filename in "${identity_file}" "${known_hosts_file}"; do
    [[ -f ${filename} && ! -L ${filename} ]] \
      || { release_die "authoritative SSH credential is invalid: ${filename}"; return 1; }
    metadata=$(stat -c '%u:%g:%a:%h' -- "${filename}") || return 1
    [[ ${metadata} == 0:0:600:1 ]] \
      || { release_die "authoritative SSH credential metadata is invalid: ${filename}"; return 1; }
  done
  expected_known_host='[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
  actual_known_host=$(<"${known_hosts_file}") || return 1
  [[ ${actual_known_host} == "${expected_known_host}" ]] \
    || { release_die 'authoritative GitHub host key pin is invalid'; return 1; }
}

release_authoritative_ssh_command() {
  printf '%s\n' '/usr/bin/ssh -F /dev/null -o HostName=ssh.github.com -o User=git -o Port=443 -o BatchMode=yes -o IdentityFile=none -i /etc/fireside-release/github_readonly_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o CertificateFile=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/fireside-release/github_known_hosts -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o VerifyHostKeyDNS=no -o KnownHostsCommand=none -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=0 -o PreferredAuthentications=publickey -o ProxyCommand=none -o ProxyJump=none -o ClearAllForwardings=yes -o PermitLocalCommand=no -o RequestTTY=no -o ControlMaster=no -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2'
}

release_git_authoritative_fetch() {
  local auth_repo=$1
  local ssh_command
  release_validate_authoritative_ssh_material || return 1
  ssh_command=$(release_authoritative_ssh_command) || return 1
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_NO_REPLACE_OBJECTS=1 GIT_SSH_VARIANT=ssh GIT_SSH_COMMAND="${ssh_command}" \
    /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null \
      -C "${auth_repo}" fetch --quiet --no-tags --depth=1 \
      ssh://git@ssh.github.com:443/ShijunDeng/fireside.git refs/heads/main
}

release_sanitize_runtime_dependencies() {
  local dependencies_root=$1
  [[ -d ${dependencies_root} && ! -L ${dependencies_root} ]] \
    || { release_die 'release dependencies root is invalid'; return 1; }
  find "${dependencies_root}" -type d -name .bin -prune -exec rm -rf -- {} + || return 1
  if find "${dependencies_root}" -type d -name .bin -print -quit | grep -q .; then
    release_die 'release dependencies retain an npm command directory'
    return 1
  fi
  if find "${dependencies_root}" -type l -print -quit | grep -q .; then
    release_die 'release dependencies contain an unsupported symbolic link'
    return 1
  fi
}

release_normalize_explicit_legacy_dependencies() {
  local release_path=$1
  local dependencies_root=${release_path}/node_modules
  local identity
  for identity in RELEASE_COMMIT RELEASE_METADATA RELEASE_MANIFEST.sha256; do
    [[ ! -e ${release_path}/${identity} && ! -L ${release_path}/${identity} ]] \
      || { release_die 'manifested release cannot be normalized as legacy'; return 1; }
  done
  [[ -d ${dependencies_root} && ! -L ${dependencies_root} ]] \
    || { release_die 'legacy dependencies root is invalid'; return 1; }
  if find "${release_path}" -type l \
    ! \( -path "${dependencies_root}/.bin/*" -o -path "${dependencies_root}/*/.bin/*" \) \
    -print -quit | grep -q .; then
    release_die 'legacy release contains a link outside npm command directories'
    return 1
  fi
  release_sanitize_runtime_dependencies "${dependencies_root}" || return 1
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
    /bin/sync -f "${dependencies_root}" || return 1
    /bin/sync -f "${release_path}" || return 1
  fi
}

release_systemctl() {
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/systemctl "$@"
}

release_systemd_run() {
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/systemd-run "$@"
}

release_prepare_sensitive_preflight_root() {
  local preflight_root=$1 parent
  [[ ${preflight_root} == /* ]] || { release_die 'sensitive preflight root must be absolute'; return 1; }
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 && ${preflight_root} != /var/lib/fireside-release/preflight ]]; then
    release_die 'production sensitive preflight root is invalid'
    return 1
  fi
  parent=$(dirname -- "${preflight_root}") || return 1
  [[ -d ${parent} && ! -L ${parent} ]] \
    || { release_die 'sensitive preflight parent must already exist'; return 1; }
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a' -- "${parent}") == root:root:700 ]] \
      || { release_die 'release state root must already be root:root 0700'; return 1; }
  fi
  install -d -o root -g root -m 0700 "${preflight_root}" || return 1
  [[ -d ${preflight_root} && ! -L ${preflight_root} \
    && $(stat -c '%U:%G:%a' -- "${preflight_root}") == root:root:700 ]] \
    || { release_die 'sensitive preflight root metadata is invalid'; return 1; }
}

release_cleanup_sensitive_preflights() {
  local preflight_root=$1 build_user=$2 entry basename owner
  release_prepare_sensitive_preflight_root "${preflight_root}" || return 1
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
    release_systemctl stop 'fireside-sensitive-preflight-*' || return 1
  fi
  while IFS= read -r -d '' entry; do
    basename=${entry##*/}
    [[ ${basename} =~ ^(install|bootstrap|promote)\.[0-9a-f]{40}\.[A-Za-z0-9]{8}$ ]] \
      || { release_die "unexpected sensitive preflight entry: ${entry}"; return 1; }
    [[ -d ${entry} && ! -L ${entry} ]] \
      || { release_die "sensitive preflight entry is not a real directory: ${entry}"; return 1; }
    owner=$(stat -c %U -- "${entry}") || return 1
    [[ ${owner} == root || ${owner} == "${build_user}" ]] \
      || { release_die "sensitive preflight entry owner is invalid: ${entry}"; return 1; }
    rm -rf --one-file-system -- "${entry}" || return 1
  done < <(find "${preflight_root}" -mindepth 1 -maxdepth 1 -print0)
  [[ -z $(find "${preflight_root}" -mindepth 1 -maxdepth 1 -print -quit) ]] || return 1
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then /bin/sync -f "${preflight_root}"; fi
}

release_units_are_active() {
  local command_name=$1
  "${command_name}" is-active --quiet fireside.socket \
    && "${command_name}" is-active --quiet fireside.service
}

release_fetch_health() {
  local url=$1
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/curl --noproxy '*' \
    -fsS --connect-timeout 1 --max-time 2 "${url}"
}

release_prepare_lock_file() {
  local lock_file=$1 expected_uid=$2 expected_gid=$3
  if [[ -L ${lock_file} || ( -e ${lock_file} && ! -f ${lock_file} ) ]]; then
    release_die "release lock is not a regular file: ${lock_file}"
    return 1
  fi
  if [[ ! -e ${lock_file} ]]; then
    local previous_umask
    previous_umask=$(umask)
    umask 077
    if ! (set -o noclobber; : > "${lock_file}") 2>/dev/null && [[ ! -f ${lock_file} || -L ${lock_file} ]]; then
      umask "${previous_umask}"
      release_die "cannot create the release lock: ${lock_file}"
      return 1
    fi
    umask "${previous_umask}"
  fi
  local metadata
  metadata=$(stat -c '%u:%g:%h' -- "${lock_file}") || return 1
  [[ ${metadata} == "${expected_uid}:${expected_gid}:1" ]] \
    || { release_die "release lock ownership or link count is invalid: ${lock_file}"; return 1; }
  chmod 0600 -- "${lock_file}" || return 1
  [[ -f ${lock_file} && ! -L ${lock_file} \
    && $(stat -c '%u:%g:%a:%h' -- "${lock_file}") == "${expected_uid}:${expected_gid}:600:1" ]] \
    || { release_die "release lock permissions are invalid: ${lock_file}"; return 1; }
}

release_validate_lock_file() {
  local lock_file=$1 expected_uid=$2 expected_gid=$3
  [[ -f ${lock_file} && ! -L ${lock_file} \
    && $(stat -c '%u:%g:%a:%h' -- "${lock_file}" 8>&- 9>&-) == "${expected_uid}:${expected_gid}:600:1" ]] \
    || { release_die "release lock metadata is invalid: ${lock_file}"; return 1; }
}

release_die() {
  echo "$1" >&2
  return 1
}

release_is_production_controller() {
  local controller_dir
  controller_dir=$(readlink -f -- "$1") || return 1
  if [[ ${controller_dir} == /usr/local/libexec/fireside-release ]]; then
    return 0
  fi
  local marker="${controller_dir}/CONTROLLER_PRODUCTION_MODE"
  [[ -f ${marker} && ! -L ${marker} && $(<"${marker}") == fireside-release-production-v1 ]]
}

release_reject_production_overrides() {
  local controller_dir=$1
  release_is_production_controller "${controller_dir}" || return 0
  local name ignored
  while IFS='=' read -r -d '' name ignored; do
    case "${name}" in
      FIRESIDE_RELEASE_*|FIRESIDE_RELEASES_ROOT|FIRESIDE_SOURCE_ROOT|FIRESIDE_CURRENT_LINK|FIRESIDE_PREVIOUS_LINK|FIRESIDE_BACKUP_DIRECTORY|FIRESIDE_DATABASE_PATH|FIRESIDE_PREFLIGHT_ROOT|FIRESIDE_RUNTIME_ROOT|FIRESIDE_BUILD_USER)
        echo 'test overrides are disabled in the installed production controller' >&2
        return 2
        ;;
    esac
  done < <(env -0)
}

release_require_root() {
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 && ${EUID} -ne 0 ]]; then
    release_die 'release operation must run as root'
  fi
}

release_require_full_commit() {
  local commit=${1:-}
  [[ ${commit} =~ ^[0-9a-f]{40}$ ]] || release_die 'release commit must be a full 40-character lowercase Git commit'
}

release_assert_child_path() {
  local parent=$1
  local candidate=$2
  [[ ${candidate} == "${parent}/"* && ${candidate} != "${parent}/" ]] \
    || release_die "unsafe release path: ${candidate}"
}

release_require_regular_file() {
  local filename=$1
  [[ -f ${filename} && ! -L ${filename} ]] || release_die "required regular file is missing: ${filename}"
}

release_manifest_lines() {
  local release_path=$1
  (
    set -o pipefail
    export LC_ALL=C
    cd -- "${release_path}"
    find . -mindepth 1 ! -path './RELEASE_MANIFEST.sha256' -print0 \
      | LC_ALL=C sort -z \
      | while IFS= read -r -d '' entry; do
          local kind mode size digest
          if [[ ${entry} == *$'\n'* || ${entry} == *$'\r'* || ${entry} == *$'\t'* ]]; then
            release_die 'release paths cannot contain tab or newline characters'
            return 1
          fi
          kind=$(stat -c %F -- "${entry}") || return 1
          mode=$(stat -c %a -- "${entry}") || return 1
          if [[ -f ${entry} ]]; then
            size=$(stat -c %s -- "${entry}") || return 1
            digest=$(sha256sum -- "${entry}" | awk '{print $1}') || return 1
          else
            size=-
            digest=-
          fi
          printf '%s\t%s\t%s\t%s\t%s\n' "${kind}" "${mode}" "${size}" "${digest}" "${entry}"
        done
  )
}

release_generate_manifest() {
  local release_path=$1
  release_manifest_lines "${release_path}" > "${release_path}/RELEASE_MANIFEST.sha256"
}

release_validate_runtime_tree() (
  exec 8>&- 9>&-
  local release_path=$1
  local release_parent
  release_parent=$(dirname -- "${release_path}") || return 1
  local ancestors=("${release_parent}")
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
    [[ ${release_path} == /opt/fireside/releases/* && ${release_parent} == /opt/fireside/releases ]] \
      || { release_die "production release path is outside the fixed root: ${release_path}"; return 1; }
    ancestors=(/opt /opt/fireside /opt/fireside/releases)
  fi
  local ancestor mode
  for ancestor in "${ancestors[@]}"; do
    [[ -d ${ancestor} && ! -L ${ancestor} ]] \
      || { release_die "release parent is not a real directory: ${ancestor}"; return 1; }
    mode=$(stat -c %a -- "${ancestor}") || return 1
    if (( (8#${mode} & 8#022) != 0 || (8#${mode} & 8#001) == 0 )); then
      release_die "release parent permissions are not service-readable: ${ancestor}"
      return 1
    fi
    if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 && $(stat -c %U -- "${ancestor}") != root ]]; then
      release_die "release parent is not root-owned: ${ancestor}"
      return 1
    fi
  done
  [[ -d ${release_path} && ! -L ${release_path} ]] || release_die "release is not a real directory: ${release_path}"
  local required
  for required in \
    server-build/server/index.js \
    server-build/server/backup-cli.js \
    server-build/dist/index.html \
    package.json \
    package-lock.json
  do
    release_require_regular_file "${release_path}/${required}" || return 1
  done
  if find "${release_path}" -type l -print -quit | grep -q .; then
    release_die "release contains a symbolic link: ${release_path}"
    return 1
  fi
  if find "${release_path}" ! -type d ! -type f -print -quit | grep -q .; then
    release_die "release contains a special file: ${release_path}"
    return 1
  fi
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
    if find "${release_path}" ! -user root -print -quit | grep -q .; then
      release_die "release contains a non-root-owned path: ${release_path}"
      return 1
    fi
    if find "${release_path}" -perm /022 -print -quit | grep -q .; then
      release_die "release contains a group/world-writable path: ${release_path}"
      return 1
    fi
    if find "${release_path}" -type d ! -perm -001 -print -quit | grep -q . \
      || find "${release_path}" -type f ! -perm -004 -print -quit | grep -q .; then
      release_die "fireside service identity cannot traverse or read release: ${release_path}"
      return 1
    fi
  fi
)

release_verify_manifest() (
  exec 8>&- 9>&-
  local release_path=$1
  local expected_commit=$2
  release_validate_runtime_tree "${release_path}" || return 1
  release_require_regular_file "${release_path}/server-build/server/preflight-cli.js" || return 1
  release_require_regular_file "${release_path}/RELEASE_COMMIT" || return 1
  release_require_regular_file "${release_path}/RELEASE_METADATA" || return 1
  release_require_regular_file "${release_path}/RELEASE_MANIFEST.sha256" || return 1
  [[ $(<"${release_path}/RELEASE_COMMIT") == "${expected_commit}" ]] \
    || release_die 'release commit marker does not match the requested commit' \
    || return 1
  grep -Fxq "commit=${expected_commit}" "${release_path}/RELEASE_METADATA" \
    || release_die 'release metadata does not match the requested commit' \
    || return 1

  if ! (set -o pipefail; release_manifest_lines "${release_path}" | cmp -s -- "${release_path}/RELEASE_MANIFEST.sha256" -); then
    release_die "release manifest mismatch: ${release_path}"
    return 1
  fi
)

release_atomic_link() (
  exec 8>&- 9>&-
  local target=$1
  local link=$2
  local temporary="${link}.tmp.$$"
  [[ -d ${target} && ! -L ${target} ]] || release_die "link target is not a release directory: ${target}" || return 1
  rm -f -- "${temporary}" || return 1
  ln -s -- "${target}" "${temporary}" || return 1
  if ! mv -Tf -- "${temporary}" "${link}"; then
    rm -f -- "${temporary}"
    return 1
  fi
)

release_resolve_link() (
  exec 8>&- 9>&-
  local link=$1
  local releases_root=$2
  [[ -L ${link} ]] || release_die "release pointer is not a symbolic link: ${link}" || return 1
  local target
  target=$(readlink -f -- "${link}")
  release_assert_child_path "${releases_root}" "${target}" || return 1
  local commit=${target##*/}
  release_require_full_commit "${commit}" || return 1
  [[ ${target} == "${releases_root}/${commit}" ]] || release_die "release pointer escaped the release root: ${link}" || return 1
  printf '%s\n' "${target}"
)

release_manifest_digest() (
  exec 8>&- 9>&-
  local release_path=$1
  if [[ -f ${release_path}/RELEASE_MANIFEST.sha256 && ! -L ${release_path}/RELEASE_MANIFEST.sha256 ]]; then
    sha256sum "${release_path}/RELEASE_MANIFEST.sha256" | awk '{print $1}'
  elif [[ -e ${release_path}/RELEASE_MANIFEST.sha256 || -L ${release_path}/RELEASE_MANIFEST.sha256 \
    || -e ${release_path}/RELEASE_METADATA || -e ${release_path}/RELEASE_COMMIT ]]; then
    release_die "release manifest digest cannot be read: ${release_path}"
    return 1
  else
    printf '%s\n' legacy-current
  fi
)

release_mark_healthy() (
  exec 8>&- 9>&-
  local state_root=$1
  local release_path=$2
  local commit=${release_path##*/}
  install -d -o root -g root -m 0700 "${state_root}" || return 1
  local temporary="${state_root}/.${commit}.healthy.$$"
  local marker="${state_root}/${commit}.healthy"
  if [[ -e ${marker} || -L ${marker} ]]; then
    release_require_regular_file "${marker}" || return 1
    if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
      [[ $(stat -c '%U:%G:%a:%h' -- "${marker}" 8>&- 9>&-) == root:root:644:1 ]] || return 1
    fi
  fi
  local digest
  digest=$(release_manifest_digest "${release_path}") || return 1
  [[ ${digest} == legacy-current || ${digest} =~ ^[0-9a-f]{64}$ ]] \
    || { release_die 'release manifest digest is invalid'; return 1; }
  if ! printf '%s %s\n' "${commit}" "${digest}" > "${temporary}" \
    || ! chmod 0644 "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]] && ! chown root:root "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! mv -Tf -- "${temporary}" "${marker}"; then
    rm -f -- "${temporary}"
    return 1
  fi
)

release_require_healthy_marker() (
  exec 8>&- 9>&-
  local state_root=$1
  local release_path=$2
  local commit=${release_path##*/}
  local marker="${state_root}/${commit}.healthy"
  release_require_regular_file "${marker}" || return 1
  if [[ ${FIRESIDE_RELEASE_TEST_MODE:-0} != 1 ]]; then
    [[ $(stat -c '%U:%G:%a:%h' "${marker}") == root:root:644:1 ]] \
      || release_die "healthy marker permissions are invalid: ${marker}" \
      || return 1
  fi
  local marker_commit marker_digest extra
  read -r marker_commit marker_digest extra < "${marker}"
  [[ ${marker_commit} == "${commit}" && -n ${marker_digest:-} && -z ${extra:-} ]] \
    || release_die "invalid healthy marker: ${marker}" \
    || return 1
  if [[ ${marker_digest} == legacy-current ]]; then
    release_validate_runtime_tree "${release_path}"
    return
  fi
  release_verify_manifest "${release_path}" "${commit}" || return 1
  [[ $(release_manifest_digest "${release_path}") == "${marker_digest}" ]] \
    || release_die "healthy marker no longer matches release manifest: ${release_path}"
)
