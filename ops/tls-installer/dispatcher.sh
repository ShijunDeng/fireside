#!/bin/bash -p
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset CDPATH ENV BASH_ENV HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR TMPDIR TMP TEMP
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH SSH_AUTH_SOCK SSH_AGENT_PID
unset FIRESIDE_WRITE_KEY FIRESIDE_SESSION_KEY SESSION_SECRET

for name in $(compgen -e); do
  case "${name}" in
    FIRESIDE_TLS_INSTALL*|GIT_*|DBUS_*|SYSTEMD_*|http_proxy|https_proxy|all_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)
      unset "${name}"
      ;;
  esac
done

readonly expected_entry=/usr/local/sbin/fireside-tls-install
readonly installer=/usr/local/libexec/fireside-tls-installer/install.sh
readonly lock=/run/fireside-tls-installer.lock
entry=$(readlink -f -- "${BASH_SOURCE[0]}")

[[ ${EUID} -eq 0 ]] || { echo 'fireside TLS installer requires root' >&2; exit 2; }
[[ ${entry} == "${expected_entry}" ]] || { echo 'production TLS installer must use the fixed entry' >&2; exit 2; }
[[ -f ${entry} && ! -L ${entry} && $(stat -c '%u:%g:%a:%h' -- "${entry}") == 0:0:755:1 ]] \
  || { echo 'TLS installer dispatcher metadata is invalid' >&2; exit 2; }
[[ -f ${installer} && ! -L ${installer} && $(stat -c '%u:%g:%a:%h' -- "${installer}") == 0:0:555:1 ]] \
  || { echo 'TLS installer implementation metadata is invalid' >&2; exit 2; }

umask 077
touch -- "${lock}"
[[ -f ${lock} && ! -L ${lock} && $(stat -c '%u:%g:%a:%h' -- "${lock}") == 0:0:600:1 ]] \
  || { echo 'TLS installer lock metadata is invalid' >&2; exit 2; }

exec /usr/bin/flock -E 75 -x -n --close "${lock}" "${installer}" "$@"
