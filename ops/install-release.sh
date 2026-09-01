#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'install-release.sh must run as root' >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_root=$(cd -- "${script_dir}/.." && pwd)
commit=${1:-}

if [[ ! ${commit} =~ ^[0-9a-f]{7,40}$ ]]; then
  echo 'usage: sudo ops/install-release.sh <git-commit>' >&2
  exit 1
fi

head_commit=$(git -C "${source_root}" rev-parse HEAD)
if [[ ${commit} != "${head_commit}" ]]; then
  echo 'release commit must exactly match the checked-out HEAD' >&2
  exit 1
fi
if [[ -n $(git -C "${source_root}" status --porcelain --untracked-files=all) ]]; then
  echo 'refusing to release a dirty working tree' >&2
  exit 1
fi

for required in \
  server-build/server/index.js \
  server-build/server/backup-cli.js \
  server-build/dist/index.html \
  package.json \
  package-lock.json
do
  if [[ ! -e "${source_root}/${required}" ]]; then
    echo "missing release artifact: ${required}" >&2
    exit 1
  fi
done

releases_root=/opt/fireside/releases
current_link=/opt/fireside/current
release_path=${releases_root}/${commit}
install -d -o root -g root -m 0755 "${releases_root}"
if [[ -e "${release_path}" || -L "${release_path}" ]]; then
  echo "immutable release already exists: ${release_path}" >&2
  exit 1
fi

staging=$(mktemp -d "${releases_root}/.${commit}.XXXXXXXX")
current_candidate=/opt/fireside/.current-${commit}-$$
cleanup() {
  if [[ -n ${staging:-} && -d ${staging} ]]; then rm -rf -- "${staging}"; fi
  if [[ -n ${current_candidate:-} && -L ${current_candidate} ]]; then rm -f -- "${current_candidate}"; fi
}
trap cleanup EXIT

cp -a -- "${source_root}/server-build" "${staging}/server-build"
install -o root -g root -m 0644 "${source_root}/package.json" "${staging}/package.json"
install -o root -g root -m 0644 "${source_root}/package-lock.json" "${staging}/package-lock.json"
npm --prefix "${staging}" ci --omit=dev

chown -R root:root "${staging}"
find "${staging}" -type d -exec chmod 0755 {} +
find "${staging}" -type f -exec chmod u+rw,go+r,go-w {} +
mv -- "${staging}" "${release_path}"
staging=

ln -s -- "${release_path}" "${current_candidate}"
mv -Tf -- "${current_candidate}" "${current_link}"
trap - EXIT

echo "installed immutable Fireside release ${commit}"
