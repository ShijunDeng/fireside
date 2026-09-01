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
main_lock_held=0
if [[ ${1:-} == --main-lock-held ]]; then
  main_lock_held=1
  shift
fi
commit=${1:-}
release_require_full_commit "${commit}"

test_mode=${FIRESIDE_RELEASE_TEST_MODE:-0}
if [[ ${production_mode} == 1 ]]; then
  test_mode=0
  source_root=/home/dsj/fireside
  releases_root=/opt/fireside/releases
  lock_file=/run/fireside-release.lock
  state_root=/var/lib/fireside-release
  runtime_root=/run/fireside-runtime
  build_user=fireside-build
  preflight_root=/run
  sensitive_preflight_root=/var/lib/fireside-release/preflight
  authoritative_remote=ssh://git@ssh.github.com:443/ShijunDeng/fireside.git
  authoritative_ref=refs/heads/main
elif [[ ${test_mode} == 1 ]]; then
  source_root=${FIRESIDE_SOURCE_ROOT:?test source root is required}
  releases_root=${FIRESIDE_RELEASES_ROOT:?test releases root is required}
  lock_file=${FIRESIDE_RELEASE_LOCK_FILE:?test lock path is required}
  state_root=${FIRESIDE_RELEASE_STATE_ROOT:-$(dirname -- "${releases_root}")/state}
  runtime_root=${FIRESIDE_RUNTIME_ROOT:-$(dirname -- "${releases_root}")/runtime}
  build_user=${FIRESIDE_BUILD_USER:-fireside-build}
  preflight_root=${FIRESIDE_PREFLIGHT_ROOT:?test preflight root is required}
  sensitive_preflight_root=${FIRESIDE_SENSITIVE_PREFLIGHT_ROOT:-${preflight_root%/}/sensitive-preflight}
  authoritative_remote=${FIRESIDE_RELEASE_AUTH_REMOTE:-${source_root}}
  authoritative_ref=${FIRESIDE_RELEASE_AUTH_REF:-refs/remotes/origin/main}
else
  release_die 'production releases must use the installed root-owned controller'
fi

release_path="${releases_root}/${commit}"
if [[ -e ${release_path} || -L ${release_path} ]]; then
  release_die "immutable release already exists: ${release_path}"
fi

if [[ ${production_mode} == 1 && ${lock_file} != /run/fireside-release.lock ]]; then
  release_die 'production release lock path is invalid'
  exit 2
fi
release_prepare_lock_file "${lock_file}" "${EUID}" "$(id -g)" || exit 2
if [[ ${main_lock_held} == 0 ]]; then
  exec flock -E 75 -x -n --close "${lock_file}" /usr/bin/setsid "${script_path}" --main-lock-held "${commit}"
fi

journal_file="${state_root}/transaction"
active_file="${runtime_root}/release-active"
if [[ -e ${journal_file} || -L ${journal_file} ]]; then
  release_die 'unfinished release transaction blocks candidate installation' || true
  exit 4
fi
if [[ -e ${active_file} || -L ${active_file} ]]; then
  release_die 'release-active marker blocks candidate installation' || true
  exit 4
fi
release_cleanup_sensitive_preflights "${sensitive_preflight_root}" "${build_user}" || exit 4

head_commit=$(release_git -C "${source_root}" rev-parse HEAD)
[[ ${commit} == "${head_commit}" ]] || release_die 'release commit must exactly match the checked-out HEAD'
if [[ -n $(release_git -C "${source_root}" status --porcelain --untracked-files=all) ]]; then
  release_die 'refusing to release a dirty working tree'
fi

if [[ ${test_mode} != 1 ]]; then
  build_uid=$(id -u "${build_user}" 2>/dev/null) || release_die "missing isolated build account: ${build_user}"
  [[ ${build_uid} -ne 0 ]] || release_die 'build account must not be root'
  [[ ${build_user} != fireside ]] || release_die 'build account must not be the production service identity'
  [[ $(id -G "${build_user}" | wc -w) -eq 1 ]] || release_die 'build account must not have supplementary groups'
fi

install -d -o root -g root -m 0755 "${releases_root}"
if [[ -e ${release_path} || -L ${release_path} ]]; then
  release_die "immutable release already exists: ${release_path}"
fi

auth_repo=
build_stage=
publish_stage=
preflight_stage=
source_archive=
cleanup() {
  local candidate
  for candidate in "${build_stage:-}" "${publish_stage:-}"; do
    if [[ -n ${candidate} && ${candidate} == "${releases_root}/."* && -d ${candidate} ]]; then
      rm -rf -- "${candidate}"
    fi
  done
  if [[ -n ${preflight_stage:-} && ${preflight_stage} == "${sensitive_preflight_root}/install."* && -d ${preflight_stage} ]]; then
    rm -rf -- "${preflight_stage}"
  fi
  if [[ -n ${source_archive:-} && ${source_archive} == "${releases_root}/.${commit}.source."*.tar && -f ${source_archive} && ! -L ${source_archive} ]]; then
    rm -f -- "${source_archive}"
  fi
  if [[ -n ${auth_repo:-} && ${auth_repo} == "${releases_root}/.${commit}.auth."* && -d ${auth_repo} && ! -L ${auth_repo} ]]; then
    rm -rf -- "${auth_repo}"
  fi
}
trap cleanup EXIT

auth_repo=$(mktemp -d "${releases_root}/.${commit}.auth.XXXXXXXX")
build_stage=$(mktemp -d "${releases_root}/.${commit}.build.XXXXXXXX")
publish_stage=$(mktemp -d "${releases_root}/.${commit}.publish.XXXXXXXX")
preflight_stage=$(mktemp -d "${sensitive_preflight_root}/install.${commit}.XXXXXXXX")
source_archive=$(mktemp "${releases_root}/.${commit}.source.XXXXXXXX.tar")

release_git -C / init --quiet --bare "${auth_repo}"
if [[ ${production_mode} == 1 ]]; then
  release_git_authoritative_fetch "${auth_repo}"
else
  release_git -C "${auth_repo}" fetch --quiet --no-tags --depth=1 "${authoritative_remote}" "${authoritative_ref}"
fi
resolved_commit=$(release_git -C "${auth_repo}" rev-parse 'FETCH_HEAD^{commit}')
[[ ${resolved_commit} == "${commit}" ]] || release_die 'release commit is not authorized by the authoritative main head'

release_git -C "${auth_repo}" archive --format=tar --output="${source_archive}" "${commit}"
source_archive_sha256=$(sha256sum "${source_archive}" | awk '{print $1}')
source_tree=$(release_git -C "${auth_repo}" rev-parse "${commit}^{tree}")
tar -x --no-same-owner --no-same-permissions -f "${source_archive}" -C "${build_stage}"
if find "${build_stage}" -type l -print -quit | grep -q .; then
  release_die 'exported source contains a symbolic link'
fi

run_build_scope() {
  local network_mode=$1
  shift
  local unit="fireside-build-${commit:0:12}-$$-${RANDOM}"
  local network_property=()
  if [[ ${network_mode} == private ]]; then network_property=(-p PrivateNetwork=yes); fi
  release_systemd_run --quiet --wait --collect --pipe --service-type=exec --unit="${unit}" \
    -p "User=${build_user}" -p "Group=${build_user}" \
    -p "WorkingDirectory=${build_stage}" \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes \
    -p PrivateTmp=yes -p PrivateDevices=yes -p RestrictSUIDSGID=yes \
    -p InaccessiblePaths="/var/lib/fireside /var/backups/fireside /etc/fireside.env ${sensitive_preflight_root}" \
    -p "ReadWritePaths=${build_stage}" -p TimeoutStartSec=20min -p RuntimeMaxSec=20min \
    "${network_property[@]}" -- \
    env -i HOME="${build_stage}/.build-home" PATH=/usr/local/bin:/usr/bin:/bin \
      npm_config_cache="${build_stage}/.npm-cache" npm_config_update_notifier=false "$@"
}

if [[ ${test_mode} == 1 ]]; then
  "${FIRESIDE_RELEASE_BUILD_HOOK:?test build hook is required}" "${build_stage}"
else
  chown -R "${build_user}:${build_user}" "${build_stage}"
  install -d -o "${build_user}" -g "${build_user}" -m 0700 "${build_stage}/.build-home" "${build_stage}/.npm-cache"
  run_build_scope network npm ci --prefix "${build_stage}" --no-audit --no-fund
  run_build_scope private npm --prefix "${build_stage}" run check
  run_build_scope private npm prune --prefix "${build_stage}" --omit=dev --ignore-scripts --offline --no-audit --no-fund
fi

for required in \
  server-build/server/index.js \
  server-build/server/backup-cli.js \
  server-build/server/preflight-cli.js \
  server-build/dist/index.html \
  package.json \
  package-lock.json \
  node_modules
do
  if [[ ! -e ${build_stage}/${required} || -L ${build_stage}/${required} ]]; then
    release_die "missing regular build artifact: ${required}"
  fi
done

if find "${build_stage}/server-build" "${build_stage}/node_modules" ! -type d ! -type f ! -type l -print -quit | grep -q .; then
  release_die 'build output contains a special file'
fi
if find "${build_stage}/server-build" "${build_stage}/node_modules" -perm /6000 -print -quit | grep -q .; then
  release_die 'build output contains a setuid or setgid path'
fi

cp -a -- "${build_stage}/server-build" "${publish_stage}/server-build"
cp -a -- "${build_stage}/node_modules" "${publish_stage}/node_modules"
install -o root -g root -m 0644 "${build_stage}/package.json" "${publish_stage}/package.json"
install -o root -g root -m 0644 "${build_stage}/package-lock.json" "${publish_stage}/package-lock.json"
if [[ -d ${publish_stage}/node_modules/.bin ]]; then
  rm -rf -- "${publish_stage}/node_modules/.bin"
fi
if find "${publish_stage}" -type l -print -quit | grep -q .; then
  release_die 'release dependencies contain unsupported symbolic links outside node_modules/.bin'
fi
printf '%s\n' "${commit}" > "${publish_stage}/RELEASE_COMMIT"
cat > "${publish_stage}/RELEASE_METADATA" <<EOF
schema=1
commit=${commit}
tree=${source_tree}
source_archive_sha256=${source_archive_sha256}
package_lock_sha256=$(sha256sum "${build_stage}/package-lock.json" | awk '{print $1}')
node_version=$(/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node --version)
npm_version=$(/usr/bin/env -i HOME=/nonexistent PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/npm --version)
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

chown -R root:root "${publish_stage}"
find "${publish_stage}" -type d -exec chmod 0755 {} +
find "${publish_stage}" -type f -exec chmod 0644 {} +
release_generate_manifest "${publish_stage}"
chmod 0644 "${publish_stage}/RELEASE_MANIFEST.sha256"
chown root:root "${publish_stage}/RELEASE_MANIFEST.sha256"
release_verify_manifest "${publish_stage}" "${commit}"

chmod 0700 "${preflight_stage}"
if [[ ${test_mode} == 1 ]]; then
  "${FIRESIDE_RELEASE_PREFLIGHT_HOOK:?test preflight hook is required}" "${publish_stage}" "${preflight_stage}/fireside.db"
else
  chown "${build_user}:${build_user}" "${preflight_stage}"
  release_systemd_run --quiet --wait --collect --pipe --service-type=exec \
    --unit="fireside-sensitive-preflight-install-${commit:0:12}-$$" \
    -p "User=${build_user}" -p "Group=${build_user}" -p PrivateNetwork=yes \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes \
    -p PrivateTmp=yes -p PrivateDevices=yes -p RestrictSUIDSGID=yes \
    -p InaccessiblePaths='/var/lib/fireside /var/backups/fireside /etc/fireside.env' \
    -p "BindPaths=${preflight_stage}:/run/fireside-sensitive-preflight" \
    -p TimeoutStartSec=2min -p RuntimeMaxSec=2min -- \
    env -i HOME=/nonexistent PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production \
      DATABASE_PATH=/run/fireside-sensitive-preflight/fireside.db \
      FIRESIDE_WRITE_KEY='release-preflight-only-key-32chars' \
      /usr/bin/node "${publish_stage}/server-build/server/preflight-cli.js" >/dev/null
fi
release_verify_manifest "${publish_stage}" "${commit}"

[[ ! -e ${release_path} && ! -L ${release_path} ]] || release_die "immutable release appeared during install: ${release_path}"
mv -T -- "${publish_stage}" "${release_path}"
publish_stage=
release_verify_manifest "${release_path}" "${commit}"
trap - EXIT
cleanup
echo "installed immutable Fireside candidate ${commit}; current was not changed"
